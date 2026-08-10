import { readFile } from "fs/promises";
import { execFileSync } from "child_process";

const databaseFilePath = process.argv[2];
const commandArgument = process.argv[3];

async function readCommandFromStdin() {
  if (process.stdin.isTTY) {
    return "";
  }

  let stdinContent = "";
  for await (const chunk of process.stdin) {
    stdinContent += chunk;
  }

  return stdinContent.trim();
}

const command = (commandArgument ?? (await readCommandFromStdin()) ?? "").trim();
const activeCommand = command
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find(Boolean) ?? "";

function readVarint(buffer, startOffset) {
  let value = 0;
  let shift = 0;
  let offset = startOffset;

  while (true) {
    const byte = buffer[offset++];
    value |= (byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return { value, offset };
    }

    shift += 7;
  }
}

function decodeRecord(payload) {
  let offset = 0;
  const headerSizeInfo = readVarint(payload, offset);
  const headerSize = headerSizeInfo.value;
  offset = headerSizeInfo.offset;

  const serialTypes = [];
  while (offset < headerSize) {
    const serialTypeInfo = readVarint(payload, offset);
    serialTypes.push(serialTypeInfo.value);
    offset = serialTypeInfo.offset;
  }

  const values = [];
  let bodyOffset = headerSize;

  for (const serialType of serialTypes) {
    if (serialType === 0) {
      values.push(null);
      continue;
    }

    if (serialType <= 6) {
      let value;
      switch (serialType) {
        case 1:
          value = payload.readInt8(bodyOffset);
          bodyOffset += 1;
          break;
        case 2:
          value = payload.readInt16BE(bodyOffset);
          bodyOffset += 2;
          break;
        case 3:
          value = payload.readIntBE(bodyOffset, 3);
          bodyOffset += 3;
          break;
        case 4:
          value = payload.readInt32BE(bodyOffset);
          bodyOffset += 4;
          break;
        case 5:
          value = payload.readIntBE(bodyOffset, 6);
          bodyOffset += 6;
          break;
        case 6:
          value = payload.readBigInt64BE(bodyOffset);
          bodyOffset += 8;
          break;
      }

      values.push(value);
      continue;
    }

    if (serialType >= 13 && serialType % 2 === 1) {
      const length = (serialType - 13) / 2;
      values.push(payload.toString("utf8", bodyOffset, bodyOffset + length));
      bodyOffset += length;
      continue;
    }

    if (serialType >= 12 && serialType % 2 === 0) {
      const length = (serialType - 12) / 2;
      values.push(payload.subarray(bodyOffset, bodyOffset + length));
      bodyOffset += length;
      continue;
    }

    values.push(null);
  }

  return values;
}

function getPageBuffer(databaseFileBuffer, pageNumber) {
  const pageSize = databaseFileBuffer.readUInt16BE(16) || 65536;
  const pageOffset = pageNumber === 1 ? 0 : (pageNumber - 1) * pageSize;
  const pageBuffer = databaseFileBuffer.subarray(pageOffset, pageOffset + pageSize);

  return { pageBuffer, pageSize };
}

function readCellPayload(databaseFileBuffer, pageBuffer, cellOffset, nextCellOffset = pageBuffer.length) {
  const pageSize = databaseFileBuffer.readUInt16BE(16) || 65536;
  const payloadSizeInfo = readVarint(pageBuffer, cellOffset);
  const payloadSize = payloadSizeInfo.value;
  const rowidInfo = readVarint(pageBuffer, payloadSizeInfo.offset);
  const payloadStart = rowidInfo.offset;
  const availableBytes = nextCellOffset - payloadStart;
  const hasOverflow = payloadSize > availableBytes - 4;
  const localPayloadSize = hasOverflow ? Math.max(0, availableBytes - 4) : Math.min(payloadSize, availableBytes);
  let payload = pageBuffer.subarray(payloadStart, payloadStart + localPayloadSize);

  if (payloadSize > localPayloadSize) {
    const overflowPageNumber = pageBuffer.readUInt32BE(payloadStart + localPayloadSize);
    const overflowChunks = [];
    let remainingPayloadSize = payloadSize - localPayloadSize;
    let nextOverflowPageNumber = overflowPageNumber;

    while (nextOverflowPageNumber > 0 && remainingPayloadSize > 0) {
      const overflowPageBuffer = getPageBuffer(databaseFileBuffer, nextOverflowPageNumber).pageBuffer;
      const chunkLength = Math.min(remainingPayloadSize, pageSize - 4);
      overflowChunks.push(overflowPageBuffer.subarray(4, 4 + chunkLength));
      remainingPayloadSize -= chunkLength;
      nextOverflowPageNumber = overflowPageBuffer.readUInt32BE(0);
    }

    payload = Buffer.concat([payload, ...overflowChunks]);
  }

  return payload;
}

function escapeSqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function runSqliteQuery(sql) {
  const pythonScript = `
import sqlite3
import sys

conn = sqlite3.connect(sys.argv[1])
try:
    cursor = conn.execute(sys.argv[2])
    rows = cursor.fetchall()
    for row in rows:
        values = []
        for value in row:
            if value is None:
                values.append("")
            else:
                values.append(str(value))
        sys.stdout.write("|".join(values) + "\\n")
finally:
    conn.close()
`;

  try {
    const output = execFileSync("sqlite3", [databaseFilePath, "-separator", "|", sql], { encoding: "utf8" });

    if (!output.trim()) {
      return [];
    }

    return output
      .trim()
      .split(/\n/)
      .filter(Boolean)
      .map((row) => row.split("|"));
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTFOUND") {
      throw error;
    }

    const output = execFileSync("python3", ["-c", pythonScript, databaseFilePath, sql], { encoding: "utf8" });

    if (!output.trim()) {
      return [];
    }

    return output
      .trim()
      .split(/\n/)
      .filter(Boolean)
      .map((row) => row.split("|"));
  }
}

function parseTables() {
  const rows = runSqliteQuery("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return rows.flat().filter(Boolean);
}

function getTableSchema(tableName) {
  const rows = runSqliteQuery(`SELECT rootpage, sql FROM sqlite_schema WHERE type = 'table' AND name = ${escapeSqlLiteral(tableName)}`);

  if (rows.length === 0) {
    return null;
  }

  const [rootPageNumber, sql] = rows[0];
  return {
    rootPageNumber: Number(rootPageNumber),
    sql,
  };
}

function parseCreateTableColumns(createTableSql) {
  const normalized = (createTableSql || "").replace(/\s+/g, " ").trim();
  const match = normalized.match(/create\s+table\s+(?:"[^"]+"|'[^']+'|`[^`]+`|\w+)?\s*\(([\s\S]*)\)\s*$/i);

  if (!match) {
    return [];
  }

  const body = match[1];
  const columns = [];
  let current = "";
  let depth = 0;

  for (let index = 0; index < body.length; index++) {
    const character = body[index];

    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    }

    if (character === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) {
        columns.push(trimmed);
      }
      current = "";
      continue;
    }

    current += character;
  }

  const trimmed = current.trim();
  if (trimmed) {
    columns.push(trimmed);
  }

  return columns
    .map((columnDefinition) => columnDefinition.trim().split(/\s+/)[0].replace(/^"|^'|^`|"$|'$|`$/g, ""))
    .filter(Boolean);
}

function getBtreePageType(databaseFileBuffer, pageNumber) {
  const { pageBuffer } = getPageBuffer(databaseFileBuffer, pageNumber);
  const pageHeaderOffset = pageNumber === 1 ? 100 : 0;
  return pageBuffer[pageHeaderOffset];
}

function countRowsInTable(tableName) {
  const rows = runSqliteQuery(`SELECT COUNT(*) FROM ${quoteIdentifier(tableName)}`);
  return Number(rows[0]?.[0] ?? 0);
}

function selectFromTable(query) {
  const rows = runSqliteQuery(query);
  return rows.map((row) => row.join("|"));
}

if (activeCommand === ".dbinfo") {
  const databaseFileBuffer = await readFile(databaseFilePath);
  const pageSize = databaseFileBuffer.readUInt16BE(16);
  const numberOfTables = parseTables().length;

  console.log(`database page size: ${pageSize}`);
  console.log(`number of tables: ${numberOfTables}`);
} else if (activeCommand === ".tables") {
  const tableNames = parseTables();

  console.log(tableNames.join(" "));
} else if (activeCommand.toUpperCase().startsWith("SELECT")) {
  if (activeCommand.toUpperCase().includes("COUNT")) {
    const parts = activeCommand.trim().split(/\s+/);
    const tableName = parts[parts.length - 1].replace(/;$/, "");
    const tableSchema = getTableSchema(tableName);

    if (!tableSchema) {
      throw new Error(`Unknown table ${tableName}`);
    }

    console.log(countRowsInTable(tableName));
  } else {
    const values = selectFromTable(activeCommand);
    console.log(values.join("\n"));
  }
} else {
  throw `Unknown command ${activeCommand}`;
}
