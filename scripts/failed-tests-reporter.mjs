export default async function* failedTests(source) {
	const failed = [];
	for await (const event of source) {
		if (event.type === 'test:fail' && event.data.nesting === 0) {
			failed.push({ file: event.data.file, name: event.data.name });
		}
	}
	yield JSON.stringify(failed);
}
