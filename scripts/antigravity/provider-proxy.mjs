// TLS is terminated by Google. This proxy only connects the isolated CLI to named provider endpoints.
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {networkInterfaces} from 'node:os';

const allowed=new Set(['accounts.google.com','aicode.googleapis.com','oauth2.googleapis.com','www.googleapis.com','antigravity.google',
  'cloudcode-pa.googleapis.com','daily-cloudcode-pa.googleapis.com','daily-cloudcode-pa.sandbox.googleapis.com',
  'autopush-cloudcode-pa.sandbox.googleapis.com','antigravity.googleapis.com','antigravity-pa.googleapis.com',
  'antigravity-unleash.goog','generativelanguage.googleapis.com','cloudcode-pa.clients6.google.com',
  'antigravity-cli-auto-updater-974169037036.us-central1.run.app','storage.googleapis.com']);
const [network,bits]=process.env.JAM_PROXY_NETWORK.split('/');
const ipv4=ip=>ip.split('.').reduce((n,v)=>(n<<8)|Number(v),0);
const address=Object.values(networkInterfaces()).flat().find(iface=>!iface.internal&&iface.family==='IPv4'&&
  (ipv4(iface.address) >>> (32-Number(bits)))===(ipv4(network) >>> (32-Number(bits))))?.address;
if(!address)throw Error('Missing private interface');
const proxy=createServer((_req,res)=>res.writeHead(403).end());
proxy.on('connect',(req,client,head)=>{
  const match=/^([a-z0-9.-]+):443$/.exec(req.url);
  if(!match||!allowed.has(match[1])){console.error('Rejected provider destination',match?.[1]?.slice(0,150));client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  // This isolated bridge has an IPv4 egress route. Address-family racing can expire viable IPv4 connections.
  const upstream=connect({port:443,host:match[1],family:4},()=>{
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if(head.length)upstream.write(head);
    client.pipe(upstream);upstream.pipe(client);
  });
  const close=()=>{upstream.destroy();client.destroy();};
  // Quiet provider inference may outlast three minutes. Let the owning review enforce its deadline.
  upstream.setTimeout(32*60*1000,close);
  upstream.on('error',close);client.on('error',close);client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
});
proxy.listen(3130,address);
