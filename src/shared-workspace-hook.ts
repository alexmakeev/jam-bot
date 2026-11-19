import { SharedWorkspace } from "./shared-workspace.js";

let workspace: SharedWorkspace | undefined;
try {
	const path = process.argv[2];
	if (!path) throw Error("Missing workspace admission journal");
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
		if (Buffer.byteLength(input) > 65536)
			throw Error("Workspace hook input exceeded its limit");
	}
	workspace = new SharedWorkspace(path);
	if (!(await workspace.admit(JSON.parse(input))))
		throw Error("Workspace access could not be attributed");
} catch {
	process.stderr.write(
		"Workspace access was not admitted for this native dispatch.\n",
	);
	process.exitCode = 2;
} finally {
	workspace?.close();
}
