import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt();
type CommentPurpose = "needs-files" | "completion";

export function issueComment(purpose: CommentPurpose, source: string): string {
	// Preserve indentation, hard breaks, list nesting and the final line of code blocks.
	const text = source.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
	if (
		!text.trim() ||
		text.includes("<!-- jam-bot:") ||
		Array.from(text).some((character) => {
			const code = character.charCodeAt(0);
			return (
				code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)
			);
		})
	)
		throw Error("Invalid GitHub comment content");

	const lines = text.split("\n");
	const blocks = markdown.parse(text, {});
	for (const block of blocks) {
		if (block.type !== "fence" || !block.map) continue;
		const [start, end] = block.map;
		const closingLine = (lines[end - 1] ?? "")
			.replace(/^(?:\s*>)*\s*/, "")
			.trimEnd();
		const closingFence = new RegExp(
			"^" + block.markup[0] + "{" + block.markup.length + ",}$",
		);
		if (end - start < 2 || !closingFence.test(closingLine))
			throw Error("Unclosed Markdown code fence in GitHub comment");
	}
	if (
		purpose === "needs-files" &&
		!blocks.some(
			(block) =>
				block.type === "ordered_list_open" || block.type === "bullet_list_open",
		)
	)
		throw Error("The implementation plan must contain a Markdown list");

	const sections =
		purpose === "needs-files"
			? [
					"### Implementation plan",
					text,
					"**Next step**",
					"Create a linked Task with a `Files:` line listing the repository-relative paths approved for editing.",
				]
			: ["### Result", text];
	const body = [...sections, "<!-- jam-bot:" + purpose + " -->"].join("\n\n");
	if (body.length > 65536)
		throw Error("GitHub comment exceeds the issue comment size limit");
	return body;
}
