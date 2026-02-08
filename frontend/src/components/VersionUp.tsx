import { Chip } from '@mui/material';
import { useEffect, useState } from 'react';
import { Console, GetAppVersion, OpenURL } from '../../wailsjs/go/backend/App';

const repoUrl =
	'https://api.github.com/repos/Jun-Murakami/monaco-notepad/releases/latest';
const releaseUrl = 'https://jun-murakami.web.app/#monacoNotepad';

export const VersionUp = () => {
	const [version, setVersion] = useState<string>('');
	const [showChip, setShowChip] = useState<boolean>(false);

	useEffect(() => {
		const fetchVersion = async () => {
			try {
				const ver = await GetAppVersion();

				const response = await fetch(repoUrl);
				const data = await response.json();
				if (!data) {
					await Console('App version data not found', []);
					return;
				}

				const latestVersion = data.tag_name.replace('v', '');
				setVersion(latestVersion);
				if (latestVersion > ver) {
					setShowChip(true);
				} else {
					await Console('Latest version', [latestVersion, ver]);
				}
			} catch (error) {
				await Console('Failed to get version', [error]);
			}
		};
		fetchVersion();
	}, []);

	const handleClick = async () => {
		try {
			await OpenURL(releaseUrl);
		} catch (error) {
			await Console('Failed to open URL', [error]);
		}
	};

	return (
		<>
			{showChip && (
				<Chip
					label={`Update? v${version}`}
					onClick={handleClick}
					onDelete={() => setShowChip(false)}
					size="small"
					sx={{
						bgcolor: 'primary.main',
						color: 'primary.contrastText',
						ml: 2,
					}}
				/>
			)}
		</>
	);
};
