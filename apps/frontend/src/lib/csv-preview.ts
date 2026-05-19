export type ParsedCsv = {
  header: string[];
  rows: string[][];
  totalRowsSeen: number;
  truncated: boolean;
};

export function parseCsvPreview(
  input: string,
  options: { maxRows?: number; delimiter?: string } = {}
): ParsedCsv {
  const maxRows = options.maxRows ?? 100;
  const delimiter = options.delimiter ?? ",";

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };

  // Parse up to maxRows data rows + 1 header = maxRows + 1 records, then stop.
  const maxRecords = maxRows + 1;
  while (i < input.length && records.length < maxRecords) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      if (input[i + 1] === "\n") i += 1;
      pushRecord();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush trailing partial record only if we stopped because we ran out of input.
  if (i >= input.length && (field.length > 0 || record.length > 0)) {
    pushRecord();
  }

  // If we stopped because we hit the cap, count remaining records from the rest of the input.
  let totalRecords = records.length;
  const truncated = i < input.length;
  if (truncated) {
    totalRecords += countRemainingRecords(input, i);
  }

  const header = records[0] ?? [];
  const rows = records.slice(1);

  return {
    header,
    rows,
    totalRowsSeen: Math.max(totalRecords - 1, 0), // exclude header from row count
    truncated
  };
}

function countRemainingRecords(input: string, startIndex: number): number {
  let count = 0;
  let inQuotes = false;
  let sawContent = false;
  for (let i = startIndex; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          i += 1;
          continue;
        }
        inQuotes = false;
      }
      sawContent = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawContent = true;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (sawContent) {
        count += 1;
        sawContent = false;
      }
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      continue;
    }
    sawContent = true;
  }
  if (sawContent) count += 1;
  return count;
}
