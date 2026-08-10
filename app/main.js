import { readFile } from "fs/promises";

const databaseFilePath = process.argv[2];
const command = process.argv[3];

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

function parseTables(databaseFileBuffer) {
  const { pageBuffer } = getPageBuffer(databaseFileBuffer, 1);
  const pageHeaderOffset = 100;
  const cellCount = pageBuffer.readUInt16BE(pageHeaderOffset + 3);
  const cellPointerArrayOffset = pageHeaderOffset + 8;

  const tableNames = [];

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const cellOffset = pageBuffer.readUInt16BE(cellPointerArrayOffset + cellIndex * 2);
    const payloadSizeInfo = readVarint(pageBuffer, cellOffset);
    const rowidInfo = readVarint(pageBuffer, payloadSizeInfo.offset);
    const payloadStart = rowidInfo.offset;
    const payloadEnd = payloadStart + payloadSizeInfo.value;
    const payload = pageBuffer.subarray(payloadStart, payloadEnd);
    const values = decodeRecord(payload);
    const tableName = values[2] ?? values[1];

    if (values[0] === "table" && tableName && !tableName.startsWith("sqlite_")) {
      tableNames.push(tableName);
    }
  }

  return tableNames.sort((left, right) => left.localeCompare(right));
}

function getTableSchema(databaseFileBuffer, tableName) {
  const { pageBuffer } = getPageBuffer(databaseFileBuffer, 1);
  const pageHeaderOffset = 100;
  const cellCount = pageBuffer.readUInt16BE(pageHeaderOffset + 3);
  const cellPointerArrayOffset = pageHeaderOffset + 8;

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const cellOffset = pageBuffer.readUInt16BE(cellPointerArrayOffset + cellIndex * 2);
    const payloadSizeInfo = readVarint(pageBuffer, cellOffset);
    const rowidInfo = readVarint(pageBuffer, payloadSizeInfo.offset);
    const payloadStart = rowidInfo.offset;
    const payloadEnd = payloadStart + payloadSizeInfo.value;
    const payload = pageBuffer.subarray(payloadStart, payloadEnd);
    const values = decodeRecord(payload);
    const schemaTableName = values[2] ?? values[1];

    if (values[0] === "table" && schemaTableName === tableName) {
      return {
        rootPageNumber: values[3],
        sql: values[4],
      };
    }
  }

  return null;
}

function parseCreateTableColumns(createTableSql) {
  const match = createTableSql.match(/create\s+table\s+(?:"[^"]+"|'[^']+'|`[^`]+`|\w+)?\s*\(([\s\S]*)\)\s*$/i);

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

function countRowsInTable(databaseFileBuffer, rootPageNumber) {
  const { pageBuffer } = getPageBuffer(databaseFileBuffer, rootPageNumber);
  const pageHeaderOffset = rootPageNumber === 1 ? 100 : 0;
  const cellCount = pageBuffer.readUInt16BE(pageHeaderOffset + 3);

  return cellCount;
}

function readRowsFromTable(databaseFileBuffer, rootPageNumber) {
  const { pageBuffer } = getPageBuffer(databaseFileBuffer, rootPageNumber);
  const pageHeaderOffset = rootPageNumber === 1 ? 100 : 0;
  const cellCount = pageBuffer.readUInt16BE(pageHeaderOffset + 3);
  const cellPointerArrayOffset = pageHeaderOffset + 8;
  const rows = [];

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const cellOffset = pageBuffer.readUInt16BE(cellPointerArrayOffset + cellIndex * 2);
    const payloadSizeInfo = readVarint(pageBuffer, cellOffset);
    const rowidInfo = readVarint(pageBuffer, payloadSizeInfo.offset);
    const payloadStart = rowidInfo.offset;
    const payloadEnd = payloadStart + payloadSizeInfo.value;
    const payload = pageBuffer.subarray(payloadStart, payloadEnd);
    rows.push(decodeRecord(payload));
  }

  return rows;
}

function selectFromTable(databaseFileBuffer, query) {
  const match = query.match(/^SELECT\s+(.+)\s+FROM\s+([A-Za-z_][\w".`]*)$/i);

  if (!match) {
    throw new Error(`Unsupported query ${query}`);
  }

  const [, columnList, tableName] = match;
  const tableSchema = getTableSchema(databaseFileBuffer, tableName);

  if (!tableSchema) {
    throw new Error(`Unknown table ${tableName}`);
  }

  const columnNames = parseCreateTableColumns(tableSchema.sql);
  const requestedColumns = columnList
    .split(",")
    .map((columnName) => columnName.trim())
    .filter(Boolean);

  const columnIndexes = requestedColumns.map((columnName) => {
    const columnIndex = columnNames.findIndex((name) => name.toLowerCase() === columnName.toLowerCase());

    if (columnIndex === -1) {
      throw new Error(`Unknown column ${columnName}`);
    }

    return columnIndex;
  });

  const rows = readRowsFromTable(databaseFileBuffer, tableSchema.rootPageNumber);
  return rows.map((row) => columnIndexes.map((columnIndex) => row[columnIndex]).join("|"));
}

if (command === ".dbinfo") {
  const databaseFileBuffer = await readFile(databaseFilePath);
  const pageSize = databaseFileBuffer.readUInt16BE(16);
  const numberOfCells = databaseFileBuffer.readUInt16BE(103);

  console.log(`database page size: ${pageSize}`);
  console.log(`number of tables: ${numberOfCells}`);
} else if (command === ".tables") {
  const databaseFileBuffer = await readFile(databaseFilePath);
  const tableNames = parseTables(databaseFileBuffer);

  console.log(tableNames.join(" "));
} else if (command.toUpperCase().startsWith("SELECT")) {
  const databaseFileBuffer = await readFile(databaseFilePath);

  if (command.toUpperCase().includes("COUNT")) {
    const parts = command.trim().split(/\s+/);
    const tableName = parts[parts.length - 1];
    const tableSchema = getTableSchema(databaseFileBuffer, tableName);

    if (!tableSchema) {
      throw new Error(`Unknown table ${tableName}`);
    }

    console.log(countRowsInTable(databaseFileBuffer, tableSchema.rootPageNumber));
  } else {
    const values = selectFromTable(databaseFileBuffer, command);
    console.log(values.join("\n"));
  }
} else {
  throw `Unknown command ${command}`;
}
