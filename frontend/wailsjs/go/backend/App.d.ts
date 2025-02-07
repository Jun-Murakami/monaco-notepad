// Cynhyrchwyd y ffeil hon yn awtomatig. PEIDIWCH Â MODIWL
// This file is automatically generated. DO NOT EDIT
import {backend} from '../models';

export function AuthorizeDrive():Promise<string>;

export function BringToFront():Promise<void>;

export function CheckDriveConnection():Promise<boolean>;

export function CompleteAuth(arg1:string):Promise<void>;

export function DeleteNote(arg1:string):Promise<void>;

export function DeleteNoteDrive(arg1:string):Promise<void>;

export function DestroyApp():Promise<void>;

export function InitializeDrive():Promise<void>;

export function ListNotes():Promise<Array<backend.Note>>;

export function LoadArchivedNote(arg1:string):Promise<backend.Note>;

export function LoadNote(arg1:string):Promise<backend.Note>;

export function LoadSettings():Promise<backend.Settings>;

export function LogoutDrive():Promise<void>;

export function NotifyFrontendReady():Promise<void>;

export function OpenFile(arg1:string):Promise<string>;

export function OpenFileFromExternal(arg1:string):Promise<void>;

export function SaveFile(arg1:string,arg2:string):Promise<void>;

export function SaveNote(arg1:backend.Note):Promise<void>;

export function SaveNoteList():Promise<void>;

export function SaveSettings(arg1:backend.Settings):Promise<void>;

export function SaveWindowState(arg1:backend.Context):Promise<void>;

export function SelectFile():Promise<string>;

export function SelectSaveFileUri(arg1:string,arg2:string):Promise<string>;

export function SyncNotes():Promise<void>;

export function SyncNow():Promise<void>;

export function UpdateNoteOrder(arg1:string,arg2:number):Promise<void>;

export function UploadNote(arg1:backend.Note):Promise<void>;
