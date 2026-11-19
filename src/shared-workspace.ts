import { DatabaseSync } from "node:sqlite";
import { mailboxReceipt, nativeWorkspaceTurn } from "./native-teammate.js";
import { workspaceDigest, type WorkspaceBinding } from "./workspace-binding.js";

interface Scope {
	id: string;
	session: string;
	handle: string;
	member: string;
	manifest: string;
	digest: string;
	transcript: string;
	promptDigest: string;
	requestDigest: string;
}
interface HookCall {
	session_id?: string;
	agent_id?: string;
	prompt_id?: string;
	tool_use_id?: string;
	tool_name?: string;
	tool_input?: unknown;
}
const callId = /^toolu_[\w-]{1,120}$/;
const tool = /^mcp__jam_workspace__(workspace_(?:read|search|list))$/;
const normalize = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(normalize)
		: value && typeof value === "object"
			? Object.fromEntries(
					Object.entries(value)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([key, entry]) => [key, normalize(entry)]),
				)
			: value;
const operation = (name: string, input: unknown) =>
	workspaceDigest(JSON.stringify([name, normalize(input)]));

export class SharedWorkspace {
	private readonly db: DatabaseSync;
	constructor(path: string, initialize = false) {
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA busy_timeout=3000;");
		if (initialize)
			this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS workspace_members(session TEXT NOT NULL,member TEXT NOT NULL,handle TEXT NOT NULL,PRIMARY KEY(session,member),UNIQUE(session,handle));
      CREATE TABLE IF NOT EXISTS workspace_dispatches(id TEXT PRIMARY KEY,session TEXT NOT NULL,handle TEXT NOT NULL,scope TEXT NOT NULL,open INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_workspace_member ON workspace_dispatches(session,handle) WHERE open=1;
      CREATE TABLE IF NOT EXISTS workspace_admissions(call TEXT PRIMARY KEY,id TEXT NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL,expires INTEGER NOT NULL);`);
	}
	close() {
		this.db.close();
	}
	private write<T>(fn: () => T) {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const value = fn();
			this.db.exec("COMMIT");
			return value;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	async enroll(query: Parameters<typeof mailboxReceipt>[0]) {
		const native = await mailboxReceipt(query);
		if (!native)
			throw Error(
				"Native workspace member has no authenticated spawn and reply",
			);
		return this.write(() => {
			this.db
				.prepare("INSERT OR IGNORE INTO workspace_members VALUES(?,?,?)")
				.run(query.session, query.name, native.developer);
			const member = this.db
				.prepare(
					"SELECT handle FROM workspace_members WHERE session=? AND member=?",
				)
				.get(query.session, query.name);
			if (member?.handle !== native.developer)
				throw Error(
					"Native workspace member changed within its lead generation",
				);
			return native.developer;
		});
	}
	prepare(scope: Scope) {
		const encoded = JSON.stringify(scope);
		this.write(() => {
			if (
				!this.db
					.prepare(
						"SELECT 1 FROM workspace_members WHERE session=? AND member=? AND handle=?",
					)
					.get(scope.session, scope.member, scope.handle)
			)
				throw Error("Workspace scope has no enrolled native member");
			const saved = this.db
				.prepare("SELECT scope,open FROM workspace_dispatches WHERE id=?")
				.get(scope.id);
			if (saved) {
				if (saved.scope !== encoded || saved.open !== 1)
					throw Error("Shared workspace dispatch differs from its saved scope");
				return;
			}
			if (
				this.db
					.prepare(`SELECT 1 FROM workspace_admissions a JOIN workspace_dispatches d ON d.id=a.id
          WHERE d.session=? AND d.handle=? AND a.status='reading' LIMIT 1`)
					.get(scope.session, scope.handle)
			)
				throw Error("Previous shared workspace readers have not drained");
			this.db
				.prepare("INSERT INTO workspace_dispatches VALUES(?,?,?,?,1)")
				.run(scope.id, scope.session, scope.handle, encoded);
		});
	}
	retire(id: string) {
		const draining = this.write(() => {
			this.db
				.prepare("UPDATE workspace_dispatches SET open=0 WHERE id=?")
				.run(id);
			return this.db
				.prepare(
					"SELECT 1 FROM workspace_admissions WHERE id=? AND status='reading' LIMIT 1",
				)
				.get(id);
		});
		if (draining) throw Error("Shared workspace readers have not drained");
	}
	usedCalls(id: string, session: string, handle: string) {
		const rows = this.db
			.prepare(`SELECT a.call FROM workspace_admissions a
      JOIN workspace_dispatches d ON d.id=a.id
      WHERE a.id=? AND d.session=? AND d.handle=? AND a.status='used'`)
			.all(id, session, handle);
		return new Set(rows.map((row) => String(row.call)));
	}
	async admit(input: HookCall) {
		const {
			session_id: session,
			agent_id: actor,
			prompt_id: prompt,
			tool_use_id: call,
			tool_name: name,
		} = input;
		if (!session || !actor || !prompt || !call || !callId.test(call) || !name)
			return false;
		const matched = tool.exec(name);
		if (!matched) return false;
		const row = this.db
			.prepare(
				"SELECT scope FROM workspace_dispatches WHERE session=? AND handle=? AND open=1",
			)
			.get(session, actor);
		if (typeof row?.scope !== "string") return false;
		const scope = JSON.parse(row.scope) as Scope;
		if (
			!(await nativeWorkspaceTurn(
				scope.transcript,
				scope.session,
				prompt,
				scope.member,
				scope.promptDigest,
				scope.requestDigest,
			))
		)
			return false;
		return this.write(() => {
			if (
				!this.db
					.prepare("SELECT 1 FROM workspace_dispatches WHERE id=? AND open=1")
					.get(scope.id)
			)
				return false;
			return (
				this.db
					.prepare(
						"INSERT OR IGNORE INTO workspace_admissions VALUES(?,?,?,'issued',?)",
					)
					.run(
						call,
						scope.id,
						operation(matched[1]!, input.tool_input),
						Date.now() + 30000,
					).changes === 1
			);
		});
	}
	take(call: unknown, session: string, name: string, input: unknown) {
		if (typeof call !== "string" || !callId.test(call))
			throw Error("Shared workspace call has no native admission");
		return this.write(() => {
			const row = this.db
				.prepare(`SELECT d.scope FROM workspace_admissions a JOIN workspace_dispatches d ON d.id=a.id
        WHERE a.call=? AND a.operation=? AND a.status='issued' AND a.expires>=? AND d.session=? AND d.open=1`)
				.get(call, operation(name, input), Date.now(), session);
			if (typeof row?.scope !== "string")
				throw Error("Shared workspace call has no live admission");
			this.db
				.prepare(
					"UPDATE workspace_admissions SET status='reading' WHERE call=?",
				)
				.run(call);
			const scope = JSON.parse(row.scope) as Scope;
			const binding: WorkspaceBinding = {
				session,
				member: scope.member,
				challenge: scope.id,
			};
			return {
				manifest: scope.manifest,
				digest: scope.digest,
				binding,
				finish: () => {
					this.db
						.prepare(
							"UPDATE workspace_admissions SET status='used' WHERE call=? AND status='reading'",
						)
						.run(call);
				},
			};
		});
	}
}
