# Lessons

Patterns learned from user corrections, kept up to date per CLAUDE.md's Self-Improvement Loop.

## 2026-07-19 — RLS policy recursion shipped to prod
- Mistake: 20260717i added a shifts policy subquerying applications; applications policies subquery shifts back → "infinite recursion detected in policy" broke ALL authenticated shift/application reads live until 20260717j hotfix.
- Rule: before handing the owner any new RLS policy, grep existing policies on every table the new policy references — if any of them reference back, wrap the check in a security definer function from the start.
- Rule: after the owner runs a migration I authored, immediately smoke-test the app's main read paths (Discover list + My Bids) before moving on.
