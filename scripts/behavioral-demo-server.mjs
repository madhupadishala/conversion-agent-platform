import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
const html=join(here,'../public/behavioral-booking-demo.html');
const port=Number(process.env.PORT||3210);
createServer(async(req,res)=>{if((req.url||'/')!=='/'&&req.url!=='/behavioral-booking-demo.html'){res.writeHead(404);return res.end('Not found')}const body=await readFile(html);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(body)}).listen(port,'127.0.0.1',()=>console.log(`Behavioral booking demo: http://127.0.0.1:${port}`));