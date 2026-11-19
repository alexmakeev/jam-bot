import { createConnection } from "node:net";
import { fork } from "node:child_process";
import type { Assignment, Config, Observation } from "./model.js";
export async function inspect(a: Assignment): Promise<Observation> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port: a.port });
		let result = "";
		let settled = false;
		const finish = (value: Observation): void => {
			if (!settled) {
				settled = true;
				socket.destroy();
				resolve(value);
			}
		};
		socket.setTimeout(1000, () => finish("unknown"));
		socket.on("data", (data) => {
			result += data.toString();
			if (result.includes("\n"))
				finish(result.trim() === a.token ? "active" : "unknown");
		});
		socket.on("error", (e: NodeJS.ErrnoException) =>
			finish(e.code === "ECONNREFUSED" ? "absent" : "unknown"),
		);
		socket.on("end", () => finish("unknown"));
	});
}
/** Fixture runner, deliberately not called a Claude teammate. */
export async function startFixture(
	config: Config,
	a: Assignment,
): Promise<"started" | "active"> {
	return new Promise((resolve, reject) => {
		const child = fork(
			new URL("./worker.js", import.meta.url),
			[JSON.stringify(config), JSON.stringify(a)],
			{
				detached: true,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			},
		);
		const timer = setTimeout(() => {
			child.disconnect();
			child.unref();
			reject(new Error("Launch uncertain; inspect before retry"));
		}, 5000);
		child.once("message", (message) => {
			clearTimeout(timer);
			if (child.connected) child.disconnect();
			child.unref();
			const reply = message as {
				status: "started" | "active" | "error";
				error?: string;
			};
			if (reply.status === "error") reject(new Error(reply.error));
			else resolve(reply.status);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code) reject(new Error(`Runner exited: ${code}`));
		});
	});
}
