'use strict';
// Update archives and application trees are physical bytes. Electron's normal
// fs treats *.asar as virtual directories, including while extracting a file.
try{module.exports=require('original-fs');}
catch(error){
 if(process.versions.electron||error.code!=='MODULE_NOT_FOUND'||!/^Cannot find module 'original-fs'(?:\r?\n|$)/.test(error.message))throw error;
 module.exports=require('node:fs');
}
