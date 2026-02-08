// Mock worker for vitest - monaco-editor workers are not available in test environment
export default class MockWorker {
	postMessage() {}
	terminate() {}
	addEventListener() {}
	removeEventListener() {}
}
