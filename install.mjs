import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const dshHome=path.join(os.homedir(),'.dsh');
const profile=path.join(dshHome,'profiles','desktop');
const manifestPath=path.join(profile,'package.json');
const name='dsh-plugin-codex-mirror';
const target=path.join(profile,'node_modules',name);

function same(a,b){return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b}
function readManifest(){return JSON.parse(fs.readFileSync(manifestPath,'utf8'))}
function writeAtomic(file,text){const temp=`${file}.codex-mirror.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(temp,text,{flag:'wx'});fs.renameSync(temp,file)}
function backup(){const file=path.join(profile,`${name}-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);fs.copyFileSync(manifestPath,file,fs.constants.COPYFILE_EXCL);return file}
function removeLink(){if(!fs.existsSync(target))return false;const real=fs.realpathSync(target);if(!same(real,source))throw new Error(`Refusing to remove a different plugin: ${target} -> ${real}`);fs.rmSync(target,{recursive:true,force:false});return true}
function install(){
 if(!fs.existsSync(manifestPath))throw new Error(`DSH desktop profile not found: ${manifestPath}`);
 const manifest=readManifest();
 if(fs.existsSync(target)){const real=fs.realpathSync(target);if(!same(real,source))throw new Error(`Plugin target already points elsewhere: ${target} -> ${real}`)}
 const before=fs.readFileSync(manifestPath,'utf8');const backupPath=backup();
 if(!fs.existsSync(target))fs.symlinkSync(source,target,process.platform==='win32'?'junction':'dir');
 manifest.dependencies??={};manifest.dependencies[name]=`link:${source.replaceAll('\\','/')}`;
 manifest.dsh??={};manifest.dsh.profile??={};manifest.dsh.profile.bundles??=[];
 if(!manifest.dsh.profile.bundles.includes(name))manifest.dsh.profile.bundles.push(name);
 if(fs.readFileSync(manifestPath,'utf8')!==before)throw new Error('Profile changed while installing; no manifest write performed');
 writeAtomic(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({action:'install',plugin:source,profile:manifestPath,link:target,backup:backupPath},null,2));
}
function uninstall(){
 if(!fs.existsSync(manifestPath)){console.log(JSON.stringify({action:'uninstall',removed:false,reason:'profile-not-found'}));return}
 const manifest=readManifest();const backupPath=backup();
 if(manifest.dependencies?.[name]!==undefined)delete manifest.dependencies[name];
 if(manifest.dsh?.profile?.bundles)manifest.dsh.profile.bundles=manifest.dsh.profile.bundles.filter(item=>item!==name);
 writeAtomic(manifestPath,JSON.stringify(manifest,null,2)+'\n');const removed=removeLink();
 console.log(JSON.stringify({action:'uninstall',removed,profile:manifestPath,backup:backupPath},null,2));
}
if(process.argv.includes('--uninstall'))uninstall();else install();
