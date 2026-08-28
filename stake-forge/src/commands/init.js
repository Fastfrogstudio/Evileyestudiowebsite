import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

export function init({ cwd }) {
	const files = [
		['game-spec.example.yaml', 'game-spec.yaml'],
		['assets-manifest.example.yaml', 'assets-manifest.yaml'],
		['inspiration.example.yaml', 'inspiration.yaml'],
	];
	for (const [src, dest] of files) {
		const destPath = path.join(cwd, dest);
		if (fs.existsSync(destPath)) {
			console.log(chalk.yellow(`  ! ${dest} already exists, skipping`));
			continue;
		}
		fs.copySync(path.join(TEMPLATES_DIR, src), destPath);
		console.log(chalk.green('✓'), `wrote ${dest}`);
	}
	fs.ensureDirSync(path.join(cwd, 'assets-source'));
	console.log(chalk.green('✓'), 'created assets-source/ (drop your exported art/spine files here)');
	console.log(chalk.bold.cyan('\nFastest path to seeing it run (no art needed):'));
	console.log('  forge art:placeholder --spec game-spec.yaml');
	console.log('  forge math:scaffold   --spec game-spec.yaml --math-sdk ./math-sdk');
	console.log('  forge scaffold        --spec game-spec.yaml --sdk ./web-sdk');
	console.log('  forge assets:import   --manifest assets-manifest.yaml --sdk ./web-sdk --game <game-name> --spec game-spec.yaml');
	console.log(chalk.bold.cyan('\nStarting from a feature checklist?'));
	console.log('  forge inspire --in inspiration.yaml --out game-spec.draft.yaml');
	console.log(chalk.bold.cyan('\nOtherwise, edit game-spec.yaml + assets-manifest.yaml, then:'));
	console.log('  forge audit         --spec game-spec.yaml --manifest assets-manifest.yaml');
	console.log('  forge math:scaffold --spec game-spec.yaml --math-sdk ./math-sdk');
	console.log('  forge scaffold      --spec game-spec.yaml --sdk ./web-sdk');
	console.log('  forge assets:import --manifest assets-manifest.yaml --sdk ./web-sdk --game <game-name>');
	console.log('  forge verify        --spec game-spec.yaml --math-sdk ./math-sdk --sdk ./web-sdk\n');
}
