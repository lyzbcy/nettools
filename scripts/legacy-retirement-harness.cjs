'use strict';
// Test/CI compiler only. Never packaged or called by the product.
const fs=require('node:fs/promises'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util'),run=promisify(execFile);
const root=path.resolve(__dirname,'..');
async function compileEmitter(directory,fixture){
 let source=await fs.readFile(path.join(root,'src/NetRepair.swift'),'utf8');source=source.slice(0,source.indexOf('final class Engine'));
 if(fixture){
  if(!fixture.file.startsWith(directory+path.sep)||!Number.isInteger(fixture.uid)||!/^[a-f0-9]{64}$/.test(fixture.sha256))throw Error('OWNED_FIXTURE_REQUIRED');
  source=source.replace('let legacyHelper = "/usr/local/bin/netrepair-helper"',`let legacyHelper = ${JSON.stringify(fixture.file)}`).replace(/let legacyHelperHash = "[a-f0-9]{64}"/,`let legacyHelperHash = "${fixture.sha256}"`).replace('st.st_uid == 0',`st.st_uid == ${fixture.uid}`).replace("'0:104755'",`'${fixture.uid}:104755'`);
 }
 const swift=path.join(directory,'legacy-emitter.swift'),binary=path.join(directory,'legacy-emitter');
 source+='\n@main struct LegacyEmitter { static func main() { do { let staged = CommandLine.arguments.count == 1; let data = try jsonData(["retirement": try legacyRetirement(staged: staged), "cleanup": installationStageCleanup()]); print(String(data:data,encoding:.utf8)!) } catch { fputs("LEGACY_HELPER_UNVERIFIED\\n",stderr); exit(1) } } }\n';
 await fs.writeFile(swift,source);await run('/usr/bin/xcrun',['swiftc','-parse-as-library',path.join(root,'src/NetRepairHelper.swift'),swift,'-o',binary],{maxBuffer:1024*1024});return binary;
}
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
function script(stage,emission,after=':'){return ['set -eu',`stage=${quote(stage)}`,emission.cleanup,emission.retirement,after].join('\n');}
module.exports={compileEmitter,script,quote};
