export namespace backend {
	
	export class Note {
	    id: string;
	    title: string;
	    content: string;
	    contentHeader: string;
	    language: string;
	    modifiedTime: string;
	    archived: boolean;
	    folderId?: string;
	    syncing?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Note(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.content = source["content"];
	        this.contentHeader = source["contentHeader"];
	        this.language = source["language"];
	        this.modifiedTime = source["modifiedTime"];
	        this.archived = source["archived"];
	        this.folderId = source["folderId"];
	        this.syncing = source["syncing"];
	    }
	}
	export class ConflictBackupEntry {
	    id: string;
	    filename: string;
	    kind: string;
	    createdAt: string;
	    note?: Note;
	
	    static createFrom(source: any = {}) {
	        return new ConflictBackupEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.filename = source["filename"];
	        this.kind = source["kind"];
	        this.createdAt = source["createdAt"];
	        this.note = this.convertValues(source["note"], Note);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Context {
	
	
	    static createFrom(source: any = {}) {
	        return new Context(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	
	    }
	}
	export class FileNote {
	    id: string;
	    filePath: string;
	    fileName: string;
	    content: string;
	    originalContent: string;
	    language: string;
	    modifiedTime: string;
	
	    static createFrom(source: any = {}) {
	        return new FileNote(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.filePath = source["filePath"];
	        this.fileName = source["fileName"];
	        this.content = source["content"];
	        this.originalContent = source["originalContent"];
	        this.language = source["language"];
	        this.modifiedTime = source["modifiedTime"];
	    }
	}
	export class Folder {
	    id: string;
	    name: string;
	    archived?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Folder(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.archived = source["archived"];
	    }
	}
	export class IntegrityFixSelection {
	    issueId: string;
	    fixId: string;
	
	    static createFrom(source: any = {}) {
	        return new IntegrityFixSelection(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.issueId = source["issueId"];
	        this.fixId = source["fixId"];
	    }
	}
	export class IntegrityRepairSummary {
	    applied: number;
	    skipped: number;
	    errors: number;
	    messages?: string[];
	
	    static createFrom(source: any = {}) {
	        return new IntegrityRepairSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.applied = source["applied"];
	        this.skipped = source["skipped"];
	        this.errors = source["errors"];
	        this.messages = source["messages"];
	    }
	}
	
	export class OpenFileResult {
	    content: string;
	    sourceEncoding: string;
	
	    static createFrom(source: any = {}) {
	        return new OpenFileResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.content = source["content"];
	        this.sourceEncoding = source["sourceEncoding"];
	    }
	}
	export class ReleaseInfo {
	    version: string;
	    body: string;
	    downloadUrl: string;
	    assetName: string;
	
	    static createFrom(source: any = {}) {
	        return new ReleaseInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.body = source["body"];
	        this.downloadUrl = source["downloadUrl"];
	        this.assetName = source["assetName"];
	    }
	}
	export class Settings {
	    fontFamily: string;
	    fontSize: number;
	    isDarkMode: boolean;
	    editorTheme: string;
	    wordWrap: string;
	    minimap: boolean;
	    windowWidth: number;
	    windowHeight: number;
	    windowX: number;
	    windowY: number;
	    isMaximized: boolean;
	    isDebug: boolean;
	    enableConflictBackup: boolean;
	    markdownPreviewOnLeft: boolean;
	    sidebarWidth?: number;
	    splitPaneSize?: number;
	    markdownPreviewPaneSize?: number;
	    markdownPreviewVisible?: boolean;
	    isSplit?: boolean;
	    uiLanguage?: string;
	    lastActiveNoteId?: string;
	    lastActiveNoteIsFile?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fontFamily = source["fontFamily"];
	        this.fontSize = source["fontSize"];
	        this.isDarkMode = source["isDarkMode"];
	        this.editorTheme = source["editorTheme"];
	        this.wordWrap = source["wordWrap"];
	        this.minimap = source["minimap"];
	        this.windowWidth = source["windowWidth"];
	        this.windowHeight = source["windowHeight"];
	        this.windowX = source["windowX"];
	        this.windowY = source["windowY"];
	        this.isMaximized = source["isMaximized"];
	        this.isDebug = source["isDebug"];
	        this.enableConflictBackup = source["enableConflictBackup"];
	        this.markdownPreviewOnLeft = source["markdownPreviewOnLeft"];
	        this.sidebarWidth = source["sidebarWidth"];
	        this.splitPaneSize = source["splitPaneSize"];
	        this.markdownPreviewPaneSize = source["markdownPreviewPaneSize"];
	        this.markdownPreviewVisible = source["markdownPreviewVisible"];
	        this.isSplit = source["isSplit"];
	        this.uiLanguage = source["uiLanguage"];
	        this.lastActiveNoteId = source["lastActiveNoteId"];
	        this.lastActiveNoteIsFile = source["lastActiveNoteIsFile"];
	    }
	}
	export class TopLevelItem {
	    type: string;
	    id: string;
	
	    static createFrom(source: any = {}) {
	        return new TopLevelItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.id = source["id"];
	    }
	}

}

export namespace time {
	
	export class Time {
	
	
	    static createFrom(source: any = {}) {
	        return new Time(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	
	    }
	}

}

