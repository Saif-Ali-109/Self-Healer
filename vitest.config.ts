import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		fileParallelism: false,
		pool: "forks",
		poolOptions: { forks: { singleFork: true } },
	},
});
