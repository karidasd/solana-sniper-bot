import { spawn } from 'child_process';

function startServer() {
    console.log(`\n[${new Date().toLocaleTimeString()}] Starting server...`);
    const proc = spawn('node', ['index.js'], { stdio: 'inherit', cwd: process.cwd() });
    proc.on('exit', (code) => {
        console.log(`\n[${new Date().toLocaleTimeString()}] Server exited (code: ${code}). Restarting in 3s...`);
        setTimeout(startServer, 3000);
    });
}

startServer();
