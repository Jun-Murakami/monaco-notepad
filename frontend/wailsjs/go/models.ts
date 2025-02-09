export namespace backend {
	
	export class Context {
	
	
	    static createFrom(source: any = {}) {
	        return new Context(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	
	    }
	}
	export class Note {
	    id: string;
	    title: string;
	    content: string;
	    contentHeader: string;
	    language: string;
	    // Go type: time
	    modifiedTime: any;
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
	        this.modifiedTime = this.convertValues(source["modifiedTime"], null);
	        this.archived = source["archived"];
	        this.order = source["order"];
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
	    }
	}
	export class UpdateOperation {
	    type: string;
	    noteId: string;
	    content: any;
	    timestamp: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateOperation(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.noteId = source["noteId"];
	        this.content = source["content"];
	        this.timestamp = source["timestamp"];
	    }
	}

}

