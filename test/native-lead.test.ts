import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	nativeLeadBusyCode,
	nativeLeadOccupied,
	startNativeLead,
} from "../src/native-lead.js";

test(
	"a lost caller cannot overlap the native lead, and a retired writer allows exactly one successor",
	{ skip: process.platform !== "linux" },
	async (t) => {
		const state = await mkdtemp(join(tmpdir(), "jam-lead-restart-"));
		t.after(() => rm(state, { recursive: true, force: true }));
		const ready = join(state, "ready");
		const ownerProgram = `
    import {startNativeLead} from ${JSON.stringify(new URL("../src/native-lead.js", import.meta.url).href)};
    const state=process.argv[1];
    await startNativeLead(state,['-qefc','echo ready > ready; sleep 2','/dev/null'],{cwd:state});
    setInterval(()=>{},1000);`;
		const owner = spawn(
			process.execPath,
			["--input-type=module", "-e", ownerProgram, state],
			{ stdio: "ignore" },
		);
		const exited = once(owner, "exit");
		t.after(() => {
			if (owner.exitCode === null && owner.signalCode === null)
				owner.kill("SIGKILL");
		});
		const start = Date.now();
		while (!(await readFile(ready, "utf8").catch(() => false))) {
			if (Date.now() - start > 5000) assert.fail("Native writer did not start");
			await delay(15);
		}
		assert.equal(await nativeLeadOccupied(state), true);
		const duplicate = await startNativeLead(
			state,
			["-qefc", "exit 0", "/dev/null"],
			{ cwd: state },
		);
		assert.equal((await once(duplicate, "exit"))[0], nativeLeadBusyCode);
		owner.kill("SIGKILL");
		assert.equal((await exited)[1], "SIGKILL");
		const deadline = Date.now() + 5000;
		while (await nativeLeadOccupied(state)) {
			if (Date.now() > deadline)
				assert.fail("Lost writer could not be positively retired");
			await delay(20);
		}
		const predecessors = await Promise.all(
			[0, 1].map(() =>
				startNativeLead(state, ["-qefc", "sleep 0.2", "/dev/null"], {
					cwd: state,
				}),
			),
		);
		const codes = await Promise.all(
			predecessors.map((child) => once(child, "exit").then(([code]) => code)),
		);
		assert.deepEqual(
			codes.sort((a, b) => a - b),
			[0, nativeLeadBusyCode],
		);
	},
);
