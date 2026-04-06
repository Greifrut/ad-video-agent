import { createSQLiteRunEngine, loadBootstrapEnvironment, prepareBootstrapStorage } from "@shared/index";

type SQLiteRunEngine = Awaited<ReturnType<typeof createSQLiteRunEngine>>;

let enginePath: string | null = null;
let enginePromise: Promise<SQLiteRunEngine> | null = null;

export async function getRunEngine(): Promise<SQLiteRunEngine> {
  const bootstrap = loadBootstrapEnvironment(process.env);
  const sqlitePath = bootstrap.sqlitePath;

  await prepareBootstrapStorage(bootstrap);

  if (!enginePromise) {
    enginePath = sqlitePath;
    enginePromise = (async () => {
      const instance = await createSQLiteRunEngine({ sqlitePath });
      await instance.initialize();
      return instance;
    })();

    return await enginePromise;
  }

  if (enginePath !== sqlitePath) {
    const previous = await enginePromise;
    await previous.close();

    enginePath = sqlitePath;
    enginePromise = (async () => {
      const instance = await createSQLiteRunEngine({ sqlitePath });
      await instance.initialize();
      return instance;
    })();
  }

  return await enginePromise;
}

export async function resetRunEngineForTests(): Promise<void> {
  if (enginePromise) {
    const instance = await enginePromise;
    await instance.close();
  }

  enginePath = null;
  enginePromise = null;
}
