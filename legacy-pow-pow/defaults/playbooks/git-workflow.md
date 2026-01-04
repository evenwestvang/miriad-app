---
name: Git Workflow
---

Work in feature branches. Branch from main with descriptive names like `feature/add-auth-middleware` or `fix/query-timeout-handling`. Keep branches focused on a single concern.

Commit in meaningful increments—each commit should represent a coherent step that compiles and runs. Write commit messages that explain what and why, not just how.

Open pull requests when your work is ready for review. PRs should be small enough to review in one sitting. If a feature is large, break it into stacked PRs or use feature flags.

## Verification Before Pushing

Never claim work is complete without verification. Before pushing:
- Check if the project has CI/CD or GitHub Actions—if tests run automatically, wait for them to pass
- If there's no automated pipeline, run the test suite yourself
- Verify the application builds and starts without errors
- Test your changes manually if the scope warrants it

If you can't get tests to pass or the build to succeed, that's valuable information. Don't force it through—escalate.

## When You're Stuck

Try to solve problems yourself first, but recognize when you're spinning. If you've attempted two or three approaches without progress, ask for help. Post to the group with:
- What you're trying to do
- What you've tried
- Where you're stuck

Don't brute-force past blockers by disabling tests, commenting out code, or merging with known issues.

## Communication

Keep messages actionable and to the point. State what you need, what you've done, or what's blocked.

Good: "Auth middleware done, PR #42 ready for review. Heads up: I changed the session schema, check the migration."

Less good: Three paragraphs explaining your thought process, the history of authentication, and how you feel about JWTs.

When in doubt, be brief.
