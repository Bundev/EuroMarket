const { readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const verifyTestEnvironment = require('./test-environment');

async function main() {
    await verifyTestEnvironment();
    const suites = readdirSync(__dirname).filter(name => name.endsWith('.integration.js')).sort();
    if (!suites.length) throw new Error('Интеграционные наборы не найдены.');
    let failed = 0;
    for (const suite of suites) {
        console.log('\n▶ ' + suite);
        const start = performance.now();
        const result = spawnSync(process.execPath, [path.join(__dirname, suite)], {
            stdio: 'inherit', cwd: path.join(__dirname, '..')
        });
        const passed = result.status === 0;
        if (!passed) failed++;
        console.log(`${passed ? 'PASS' : 'FAIL'} ${suite} (${((performance.now() - start) / 1000).toFixed(2)} с)`);
    }
    console.log(`\nВсего: ${suites.length}. Прошло: ${suites.length - failed}. Ошибок: ${failed}.`);
    process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
