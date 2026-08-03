import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), configFile: process.cwd()+'/vite.config.js',
  server: { port: 0, strictPort: false, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const port = server.httpServer.address().port;
const b = await chromium.launch({ headless: false, args: ['--use-angle=metal','--window-position=2400,80','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 900, height: 600 } });
await p.goto(`http://127.0.0.1:${port}/?shot=hero&quality=medium&nohud=1`, { waitUntil: 'load' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 90000 });
console.log(JSON.stringify(await p.evaluate(() => {
  const g = window.__GAME__, T = g.THREE, v = new T.Vector3();
  const grab = (o) => o ? (o.getWorldPosition ? o.getWorldPosition(v).toArray().map(n=>+n.toFixed(2)) : null) : null;
  return {
    baby: g.baby?.group ? grab(g.baby.group) : null,
    babyHead: g.baby?.head ? grab(g.baby.head) : null,
    parent: g.parent?.group ? grab(g.parent.group) : null,
    parentState: g.parent?.state,
    props: g.props.list.length,
    kinds: g.props.list.reduce((a,p)=>((a[p.kind]=(a[p.kind]||0)+1),a),{}),
    edibles: g.props.list.filter(p=>p.kind==='edible').map(p=>p.id).slice(0,20),
    babyTree: (() => {
      const gr = g.baby?.group; if (!gr) return 'NO GROUP';
      let meshes = 0, verts = 0, visible = 0, names = [];
      gr.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) { meshes++; verts += o.geometry?.attributes?.position?.count || 0;
        if (o.visible) visible++; if (names.length < 12) names.push(o.name || o.type); } });
      const box = new T.Box3().setFromObject(gr);
      return { meshes, visible, verts, groupVisible: gr.visible, scale: gr.scale.toArray(),
        box: box.isEmpty() ? 'EMPTY' : [box.min.toArray().map(n=>+n.toFixed(2)), box.max.toArray().map(n=>+n.toFixed(2))], names };
    })(),
    inScene: !!(g.baby?.group?.parent),
  };
})));
await b.close(); await server.close();
