# Project responsibilities and decisions

JAM-Bot reads `.jam-bot/VALUES.md` from the repository and profile ref selected by the host operator. The publisher and release runner share `releaseProfile.profileRef`; the repository default branch is the fallback. Each read resolves one commit, verifies its directory, regular file and Git blob, and saves the reference for the assignment. The file may be absent. Keep it within 16 KiB. Include the terms, values, concrete release rules and a short responsibility table. Leave an unknown responsibility unassigned.

```markdown
## Responsibilities
| Area | Role | GitHub |
| --- | --- | --- |
```

A row uses one area, one descriptive role, and the responsible person's verified GitHub @login. Use `project lead` as the fallback area. The service first looks for the decision area, then the project lead, then the repository owner. The `architecture`, `code review`, and `integration` areas also receive the corresponding operational escalations. For organization-owned repositories the final fallback names the owning organization; any eligible human maintainer can respond.

For a material choice, a teammate can return a single line such as `Decision required [design]: Use the compact mobile layout.` The same directive can be placed in the original Task. JAM-Bot pauses the affected card, describes the scope there and supplies the exact reply text to approve or decline. Other eligible work can proceed. A maintainer can answer regardless of the responsibility table. The service checks the current GitHub account ID and repository role, originating issue and decision digest. The issue records the human, decision and scope. An authorized Task author's original request applies when the complete request exactly matches the decision. A Task may also explicitly approve the same decision in the next line using `I approve [design]: Use the compact mobile layout.`

A reply wakes the existing assignment. Restart reconciles waiting decisions against the original issue. The existing Task scope, mandatory review and stable release checks still apply; stable promotion requires separate approval of its exact SHA. See JB-37 and JB-39 in [the PRD](PRD.md).
