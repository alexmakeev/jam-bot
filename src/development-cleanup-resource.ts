import { atomicJson, readJson } from "./storage.js";
export interface CleanupResourceReceipt {
	path: string;
	status: "removing" | "removed" | "absent" | "reconciled-absent" | "retained";
	bytes?: string;
	detail?: string;
	startedAt: string;
	finishedAt?: string;
}
interface Resource {
	receipt: string;
	path: string;
	exists: () => Promise<boolean>;
	measureAndVerify: () => Promise<bigint>;
	remove: () => Promise<void>;
	afterDelete?: (path: string) => Promise<void>;
}
export async function cleanOwnedResource(
	resource: Resource,
): Promise<CleanupResourceReceipt> {
	const previous = await readJson<CleanupResourceReceipt>(
		resource.receipt,
	).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
	if (previous && previous.path !== resource.path)
		throw Error("Cleanup operation resource changed");
	const present = await resource.exists();
	if (previous && previous.status !== "removing") {
		if (
			present &&
			["removed", "absent", "reconciled-absent"].includes(previous.status)
		)
			return {
				...previous,
				status: "retained",
				detail:
					"Resource reappeared after its recorded outcome; original operation receipt preserved and replacement retained",
			};
		return previous;
	}
	if (!present) {
		const outcome: CleanupResourceReceipt = {
			path: resource.path,
			status: previous ? "reconciled-absent" : "absent",
			bytes: previous?.bytes ?? "0",
			startedAt: previous?.startedAt ?? new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			...(previous
				? {
						detail:
							"Resource absent after a durable removal intent; completion was interrupted, so removal attribution remains uncertain",
					}
				: {}),
		};
		await atomicJson(resource.receipt, outcome);
		return outcome;
	}
	let pending: CleanupResourceReceipt;
	try {
		const bytes = await resource.measureAndVerify();
		pending = {
			path: resource.path,
			status: "removing",
			bytes: bytes.toString(),
			startedAt: previous?.startedAt ?? new Date().toISOString(),
		};
		await atomicJson(resource.receipt, pending);
		await resource.remove();
	} catch (error) {
		const outcome: CleanupResourceReceipt = {
			path: resource.path,
			status: "retained",
			startedAt: previous?.startedAt ?? new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			detail: error instanceof Error ? error.message : "Cleanup failed",
		};
		await atomicJson(resource.receipt, outcome);
		return outcome;
	}
	await resource.afterDelete?.(resource.path);
	const outcome: CleanupResourceReceipt = {
		...pending,
		status: "removed",
		finishedAt: new Date().toISOString(),
	};
	await atomicJson(resource.receipt, outcome);
	return outcome;
}
