import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// The integration tests search and replace for real, which needs an open
	// folder: `workspace.workspaceFolders` is undefined otherwise and every
	// search short-circuits with "Open a folder to search in.".
	workspaceFolder: './src/test/workspace',
});
