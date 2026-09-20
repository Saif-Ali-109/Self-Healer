// Package-root resolution contract: packageRoot() must point at a directory
// containing migrations/, assets/ and .env.example. Guards the dev-time and
// bundled fallbacks (regression: the "../.." fallback resolved one level too
// high, so a fresh dev clone could never find migrations).

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { packagePath, packageRoot } from "../../src/paths.ts";

describe("packageRoot", () => {
	it("resolves to the package root (has migrations/, assets/, .env.example)", () => {
		const root = packageRoot();
		for (const entry of ["migrations", "assets", ".env.example"]) {
			expect(
				existsSync(packagePath(entry)),
				`missing ${entry} under ${root}`,
			).toBe(true);
		}
	});
});
