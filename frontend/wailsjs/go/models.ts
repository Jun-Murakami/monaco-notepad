export namespace backend {
	
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
	export class Note {
	    id: string;
	    title: string;
	    content: string;
	    contentHeader: string;
	    language: string;
	    modifiedTime: string;
	    archived: boolean;
	    order: number;
	
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
	        this.order = source["order"];
	    }
	}
	export class Settings {
	    fontFamily: string;
	    fontSize: number;
	    isDarkMode: boolean;
	    wordWrap: string;
	    minimap: boolean;
	    windowWidth: number;
	    windowHeight: number;
	    windowX: number;
	    windowY: number;
	    isMaximized: boolean;
	    isDebug: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fontFamily = source["fontFamily"];
	        this.fontSize = source["fontSize"];
	        this.isDarkMode = source["isDarkMode"];
	        this.wordWrap = source["wordWrap"];
	        this.minimap = source["minimap"];
	        this.windowWidth = source["windowWidth"];
	        this.windowHeight = source["windowHeight"];
	        this.windowX = source["windowX"];
	        this.windowY = source["windowY"];
	        this.isMaximized = source["isMaximized"];
	        this.isDebug = source["isDebug"];
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

