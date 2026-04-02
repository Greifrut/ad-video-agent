export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-8 py-20">
      <h1 className="text-3xl font-semibold tracking-tight">
        Deal Pump bootstrap is ready
      </h1>
      <p className="text-zinc-600 dark:text-zinc-300">
        Task 1 sets up the single-service Next.js + worker skeleton with SQLite
        run-engine checks, baseline tests, and deployment wiring.
      </p>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Next tasks will add domain contracts, pipeline stages, providers, and
        UI workflow.
      </p>
      <code className="rounded bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
        pnpm verify && pnpm run-engine:check
      </code>
    </main>
  );
}
