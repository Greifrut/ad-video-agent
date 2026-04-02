import sqlite3 from "sqlite3";

export type RunResult = {
  changes: number;
  lastID: number;
};

export type SqlValue = string | number | null;

export class SQLiteClient {
  private readonly database: sqlite3.Database;

  private constructor(database: sqlite3.Database) {
    this.database = database;
  }

  static async open(filePath: string): Promise<SQLiteClient> {
    const database = await new Promise<sqlite3.Database>((resolve, reject) => {
      const handle = new sqlite3.Database(filePath, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(handle);
      });
    });

    return new SQLiteClient(database);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.database.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async exec(sql: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.database.exec(sql, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    return await new Promise<RunResult>((resolve, reject) => {
      this.database.run(sql, params, function onRun(error) {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          changes: this.changes,
          lastID: this.lastID,
        });
      });
    });
  }

  async get<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    return await new Promise<T | undefined>((resolve, reject) => {
      this.database.get(sql, params, (error, row) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(row as T | undefined);
      });
    });
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return await new Promise<T[]>((resolve, reject) => {
      this.database.all(sql, params, (error, rows) => {
        if (error) {
          reject(error);
          return;
        }

        resolve((rows ?? []) as T[]);
      });
    });
  }
}
