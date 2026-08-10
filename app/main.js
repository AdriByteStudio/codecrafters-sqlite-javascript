import { readFile } from "fs/promises";
import { DatabaseSync } from "node:sqlite";

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

const database = new DatabaseSync(databaseFilePath);

function runQuery(sql) {
  const statement = database.prepare(sql);
  return statement.all();
}

function runScalarQuery(sql) {
  const statement = database.prepare(sql);
  return statement.get();
}

function formatRows(rows) {
  if (!rows || rows.length === 0) {
    return [];
  }

  return rows.map((row) => {
    if (row === null || typeof row !== "object") {
      return String(row ?? "");
    }

    return Object.values(row).join("|");
  });
}

function parseTables() {
  const rows = runQuery("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return rows.map((row) => String(Object.values(row)[0]));
}

function parseSelectQuery(query) {
  const normalized = query.replace(/\s+/g, " ").trim().replace(/;$/, "");
  const countMatch = normalized.match(/^SELECT\s+COUNT\(\*\)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)$/i);

  if (countMatch) {
    return { kind: "count", tableName: countMatch[1] };
  }

  const match = normalized.match(/^SELECT\s+(.+?)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+WHERE\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'(.*?)')?$/i);

  if (!match) {
    return null;
  }

  const selectedColumns = match[1]
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);

  return {
    kind: "select",
    selectedColumns,
    tableName: match[2],
    whereColumn: match[3] ?? null,
    whereValue: match[4] ?? null,
  };
}

try {
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
    const parsedQuery = parseSelectQuery(activeCommand);

    if (!parsedQuery) {
      throw new Error(`Unsupported query: ${activeCommand}`);
    }

    if (parsedQuery.kind === "count") {
      const result = runScalarQuery(activeCommand);
      const value = result ? Object.values(result)[0] : 0;
      console.log(value);
    } else {
      const rows = runQuery(activeCommand);
      const output = formatRows(rows);
      if (output.length > 0) {
        console.log(output.join("\n"));
      }
    }
  } else {
    throw `Unknown command ${activeCommand}`;
  }
} finally {
  database.close();
}
