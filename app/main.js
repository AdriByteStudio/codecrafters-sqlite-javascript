import { open } from "fs/promises";

const databaseFilePath = process.argv[2];
const command = process.argv[3];

if (command === ".dbinfo") {
  const databaseFileHandler = await open(databaseFilePath, "r");

  const { buffer } = await databaseFileHandler.read({
    length: 110,
    position: 0,
    buffer: Buffer.alloc(110),
  });

  const pageSize = buffer.readUInt16BE(16); // page size is 2 bytes starting at offset 16
  const numberOfCells = buffer.readUInt16BE(103); // page 1 b-tree header begins at offset 100; cells count is at relative offset 3

  console.log(`database page size: ${pageSize}`);
  console.log(`number of tables: ${numberOfCells}`);
} else {
  throw `Unknown command ${command}`;
}
