const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
let count=0;
function check(directory){
  for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())check(file);
    else if(entry.isFile()&&/\.(?:js|mjs|cjs)$/.test(entry.name)){execFileSync(process.execPath,['--check',file],{stdio:'pipe',windowsHide:true});count++;}
  }
}
for(const directory of ['lib','scripts','tests'])check(path.join(root,directory));
execFileSync(process.execPath,['--check',path.join(root,'client.js')],{stdio:'pipe',windowsHide:true});
console.log(`Syntax checked ${count+1} JavaScript files.`);
