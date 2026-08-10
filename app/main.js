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

function parseTables(databaseFileBuffer) {
  const pageSize = databaseFileBuffer.readUInt16BE(16) || 65536;
  const pageOneBuffer = databaseFileBuffer.subarray(0, pageSize);
  const pageHeaderOffset = 100;
  const cellCount = pageOneBuffer.readUInt16BE(pageHeaderOffset + 3);
  const cellPointerArrayOffset = pageHeaderOffset + 8;

  const tableNames = [];

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const cellOffset = pageOneBuffer.readUInt16BE(cellPointerArrayOffset + cellIndex * 2);
    const payloadSizeInfo = readVarint(pageOneBuffer, cellOffset);
    const rowidInfo = readVarint(pageOneBuffer, payloadSizeInfo.offset);
    const payloadStart = rowidInfo.offset;
    const payloadEnd = payloadStart + payloadSizeInfo.value;
    const payload = pageOneBuffer.subarray(payloadStart, payloadEnd);
    const values = decodeRecord(payload);

    if (values[0] === "table" && values[1] && !values[1].startsWith("sqlite_")) {
      tableNames.push(values[1]);
    }
  }

  return tableNames.sort((left, right) => left.localeCompare(right));
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
} else {
  throw `Unknown command ${command}`;
}
