export class FakeDatabase {
  readonly users = new Set<string>();

  async query(text: string, values: unknown[] = []) {
    if (text.includes("INSERT INTO users")) {
      this.users.add(String(values[0]));
      return {
        rows: [],
        rowCount: 1
      };
    }

    throw new Error(`Unexpected database query in test: ${text}`);
  }

  async end() {}
}
