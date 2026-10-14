'use strict';
module.exports=String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class UpdatePathProof {
 [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint Attributes,CreatedLow,CreatedHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileInfo info);
 [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle handle,uint type,uint flags,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle handle,uint type,uint flags,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 static SafeFileHandle Open(string file,bool write){var handle=CreateFile(file,0x20080u|(write?0x40000u:0u),3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(handle.IsInvalid){handle.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}return handle;}
 static Dictionary<string,object> Read(SafeFileHandle handle){
  FileInfo info;if(!GetFileInformationByHandle(handle,out info))throw new Win32Exception(Marshal.GetLastWin32Error());IntPtr owner,group,dacl,sacl,descriptor;uint error=GetSecurityInfo(handle,1,7,out owner,out group,out dacl,out sacl,out descriptor);if(error!=0)throw new Win32Exception((int)error);
  try{uint length=GetSecurityDescriptorLength(descriptor);if(length>65536)throw new InvalidOperationException("ACL_BOUND");var bytes=new byte[length];Marshal.Copy(descriptor,bytes,0,(int)length);var acl=new RawSecurityDescriptor(bytes,0);using(var identity=WindowsIdentity.GetCurrent()){
   var entries=new List<Dictionary<string,object>>();if(acl.DiscretionaryAcl!=null){if(acl.DiscretionaryAcl.Count>512)throw new InvalidOperationException("ACE_BOUND");foreach(GenericAce ace in acl.DiscretionaryAcl){var qualified=ace as QualifiedAce;var common=ace as CommonAce;entries.Add(new Dictionary<string,object>{{"type",ace.AceType.ToString()},{"flags",(int)ace.AceFlags},{"unsupported",common==null||qualified==null||qualified.IsCallback},{"sid",qualified==null?null:qualified.SecurityIdentifier.Value},{"rights",qualified==null?0u:unchecked((uint)qualified.AccessMask)},{"qualifier",qualified==null?null:qualified.AceQualifier.ToString()}});}}
   return new Dictionary<string,object>{{"reparse",(info.Attributes&0x400)!=0},{"directory",(info.Attributes&0x10)!=0},{"dev",info.Volume.ToString()},{"ino",(((ulong)info.IndexHigh<<32)|info.IndexLow).ToString()},{"user",identity.User.Value},{"owner",acl.Owner.Value},{"tokenOwner",identity.Owner.Value},{"adminEnabled",new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)},{"protected",(acl.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0},{"daclPresent",acl.DiscretionaryAcl!=null},{"sddl",acl.GetSddlForm(AccessControlSections.All)},{"aces",entries}};
  }}finally{LocalFree(descriptor);}
 }
 static void Ancestors(string file){var parent=Directory.GetParent(file);while(parent!=null){using(var handle=Open(parent.FullName,false)){FileInfo info;if(!GetFileInformationByHandle(handle,out info))throw new Win32Exception(Marshal.GetLastWin32Error());if((info.Attributes&0x400)!=0||(info.Attributes&0x10)==0)throw new InvalidOperationException("ANCESTOR_REPARSE_OR_NOT_DIRECTORY");}parent=parent.Parent;}}
 public static Dictionary<string,object> Inspect(string file){Ancestors(file);using(var handle=Open(file,false)){return Read(handle);}}
 public static Dictionary<string,object> ProtectNew(string file,string dev,string ino){Ancestors(file);using(var handle=Open(file,true)){
  var before=Read(handle);if((bool)before["reparse"]||!(bool)before["directory"]||(string)before["dev"]!=dev||(string)before["ino"]!=ino)throw new InvalidOperationException("NEW_DIRECTORY_IDENTITY_CHANGED");
  string user=(string)before["user"],owner=(string)before["owner"];if(owner!=user&&!(owner=="S-1-5-32-544"&&(string)before["tokenOwner"]==owner&&(bool)before["adminEnabled"]))throw new InvalidOperationException("NEW_DIRECTORY_OWNER_CHANGED");
  var dacl=new RawAcl(2,3);foreach(string sid in new[]{user,"S-1-5-18","S-1-5-32-544"})dacl.InsertAce(dacl.Count,new CommonAce(AceFlags.ContainerInherit|AceFlags.ObjectInherit,AceQualifier.AccessAllowed,0x1F01FF,new SecurityIdentifier(sid),false,null));var bytes=new byte[dacl.BinaryLength];dacl.GetBinaryForm(bytes,0);IntPtr memory=Marshal.AllocHGlobal(bytes.Length);try{Marshal.Copy(bytes,0,memory,bytes.Length);uint error=SetSecurityInfo(handle,1,0x80000004,IntPtr.Zero,IntPtr.Zero,memory,IntPtr.Zero);if(error!=0)throw new Win32Exception((int)error);}finally{Marshal.FreeHGlobal(memory);}return Read(handle);
 }}
}`;
