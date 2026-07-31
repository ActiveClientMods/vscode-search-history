# Test workspace

The folder VS Code opens when the integration tests run (see `.vscode-test.mjs`).
Searching and replacing needs a real workspace to act on; tests create their own
`tmp-*` files here and delete them again in teardown, so the folder is otherwise
kept empty on purpose.

Those scratch files are deliberately **not** in `.gitignore`: ripgrep honours
ignore rules, so an ignored fixture would never be found and the tests would
pass for the wrong reason. If a crashed run leaves a `tmp-*` file behind, delete
it — `git status` will show it.
