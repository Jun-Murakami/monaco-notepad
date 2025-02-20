// Cynhyrchwyd y ffeil hon yn awtomatig. PEIDIWCH Â MODIWL
// This file is automatically generated. DO NOT EDIT
import {context} from '../models';
import {time} from '../models';
import {backend} from '../models';

export function AuthorizeDrive():Promise<void>;

export function BringToFront():Promise<void>;

export function CancelLoginDrive():Promise<void>;

export function CheckDriveConnection():Promise<boolean>;

export function CheckFileExists(arg1:string):Promise<boolean>;

export function CheckFileModified(arg1:string,arg2:string):Promise<boolean>;

export function Console(arg1:string,arg2:Array<any>):Promise<void>;

export function DeleteNote(arg1:string):Promise<void>;

export function DestroyApp():Promise<void>;

export function DomReady(arg1:context.Context):Promise<void>;

export function GetAppVersion():Promise<string>;

export function GetModifiedTime(arg1:string):Promise<time.Time>;

export function InitializeDrive():Promise<void>;

export function ListNotes():Promise<Array<backend.Note>>;

export function LoadArchivedNote(arg1:string):Promise<backend.Note>;

export function LoadFileNotes():Promise<Array<backend.FileNote>>;

export function LoadNote(arg1:string):Promise<backend.Note>;

export function LoadSettings():Promise<backend.Settings>;

export function LogoutDrive():Promise<void>;

export function NotifyFrontendReady():Promise<void>;

export function OpenFile(arg1:string):Promise<string>;

export function OpenFileFromExternal(arg1:string):Promise<void>;

export function OpenURL(arg1:string):Promise<void>;

export function SaveFile(arg1:string,arg2:string):Promise<void>;

export function SaveFileNotes(arg1:Array<backend.FileNote>):Promise<string>;

export function SaveNote(arg1:backend.Note,arg2:string):Promise<void>;

export function SaveNoteList():Promise<void>;

export function SaveSettings(arg1:backend.Settings):Promise<void>;

export function SaveWindowState(arg1:backend.Context):Promise<void>;

export function SelectFile():Promise<string>;

export function SelectSaveFileUri(arg1:string,arg2:string):Promise<string>;

export function SyncNow():Promise<void>;

export function UpdateNoteOrder(arg1:string,arg2:number):Promise<void>;
