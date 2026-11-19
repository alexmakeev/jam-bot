import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
	prepareRunObservations,
	readRunObservations,
	RunObservation,
	runObservationFile,
} from "../dist/src/run-observations.js";

const [directory, script, ...args] = process.argv.slice(2);
if (!directory || !script)
	throw Error("Pass a private evidence directory and a native fixture script");
const file = join(directory, runObservationFile);
const db = new DatabaseSync(file);
await chmod(file, 0o600);
prepareRunObservations(db);
const child = spawn(process.execPath, [script, ...args], {
	stdio: ["ignore", "pipe", "inherit"],
});
const closed = once(child, "close");
const observer = new RunObservation(db, { pid: child.pid });
const parent = observer.begin("executor-turn");
const spans = new Map();
const members = new Map();
let incomplete = false;
const outcomes = {
	verified: "finished",
	timeout: "timeout",
	authentication_failed: "auth-failed",
	provider_refusal: "refused",
	process_exited: "interrupted",
	cancelled: "cancelled",
	error: "error",
};
function classifiedPhase(label) {
	if (typeof label !== "string" || label.length > 90) return;
	if (/^(alpha|beta) original receipt$/.test(label)) return "native-receipt";
	if (/^(alpha|beta) completed scoped read$/.test(label)) return "waiting-tool";
	if (/^(alpha|beta) exact acknowledged send and ended turn$/.test(label))
		return "native-ack";
	if (/(?:startup|bootstrap|catalog|terminal rendering)/.test(label))
		return "native-startup";
	if (label === "supervisor check") return "supervisor-turn";
	if (label === "retry wait") return "retry";
}
function record(action) {
	try {
		action();
	} catch {
		incomplete = true;
	}
}
const lines = createInterface({ input: child.stdout });
const pulse = setInterval(
	() =>
		record(() =>
			observer.heartbeat(
				child.exitCode === null && child.signalCode === null
					? "alive"
					: "exited",
			),
		),
	10_000,
);
pulse.unref();
try {
	for await (const line of lines) {
		let event;
		try {
			event = JSON.parse(line).timing;
		} catch {
			continue;
		}
		if (!event) continue;
		const kind = classifiedPhase(event.phase);
		if (!kind) continue;
		record(() => {
			if (event.event === "start" && !spans.has(event.phase)) {
				const member = /^(alpha|beta) /.exec(event.phase)?.[1];
				let owner = parent;
				if (member) {
					if (!members.has(member))
						members.set(member, observer.begin("worker", parent));
					owner = members.get(member);
				}
				const span = observer.begin(kind, owner);
				if (span) spans.set(event.phase, { span, member });
				else incomplete = true;
			}
			if (event.event === "end" && Object.hasOwn(outcomes, event.state)) {
				const open = spans.get(event.phase);
				const outcome = outcomes[event.state];
				if (!open) return;
				if (!observer.end(open.span, outcome)) incomplete = true;
				spans.delete(event.phase);
				if (open.member && kind === "native-receipt") {
					const member = members.get(open.member);
					if (member && !observer.end(member, outcome)) incomplete = true;
					members.delete(open.member);
				}
			}
		});
	}
	const [code, signal] = await closed;
	const result = code === 0 ? "finished" : signal ? "interrupted" : "error";
	incomplete ||= spans.size > 0 || members.size > 0;
	record(() => {
		if (parent) observer.end(parent, result);
		observer.finish(result, "exited");
	});
	let summary;
	record(() => {
		summary = readRunObservations(db, undefined, undefined, 0, 5).data.find(
			(row) => row.id === observer.run,
		);
	});
	console.log(
		JSON.stringify({
			run: observer.run,
			generation: observer.generation,
			code,
			interrupted: !!signal,
			incomplete,
			summary,
		}),
	);
	process.exitCode = code ?? 1;
} finally {
	clearInterval(pulse);
	db.close();
}
