import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Link,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';

import { GetAppVersion, OpenURL } from '../../wailsjs/go/backend/App';

interface LicenseEntry {
  id: number;
  name: string;
  license: string;
  repository: string;
}

interface LicenseDialogProps {
  open: boolean;
  onClose: () => void;
}

export const LicenseDialog: React.FC<LicenseDialogProps> = ({
  open,
  onClose,
}) => {
  const { t } = useTranslation();
  const [version, setVersion] = useState('');
  const [frontendLicenses, setFrontendLicenses] = useState<LicenseEntry[]>([]);
  const [backendLicenses, setBackendLicenses] = useState<LicenseEntry[]>([]);
  const [activeTab, setActiveTab] = useState(0);

  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();

    GetAppVersion().then((v) => {
      if (!controller.signal.aborted) setVersion(v);
    });

    fetch('/frontend-licenses.json', { signal: controller.signal })
      .then((res) => res.json())
      .then((data: Omit<LicenseEntry, 'id'>[]) =>
        setFrontendLicenses(data.map((entry, i) => ({ ...entry, id: i }))),
      )
      .catch(() => {
        if (!controller.signal.aborted) setFrontendLicenses([]);
      });

    fetch('/backend-licenses.json', { signal: controller.signal })
      .then((res) => res.json())
      .then((data: Omit<LicenseEntry, 'id'>[]) =>
        setBackendLicenses(data.map((entry, i) => ({ ...entry, id: i }))),
      )
      .catch(() => {
        if (!controller.signal.aborted) setBackendLicenses([]);
      });

    return () => controller.abort();
  }, [open]);

  const columns: GridColDef[] = [
    {
      field: 'name',
      headerName: t('about.packageName'),
      flex: 2,
      minWidth: 200,
    },
    {
      field: 'license',
      headerName: t('about.licenseType'),
      flex: 1,
      minWidth: 100,
    },
    {
      field: 'repository',
      headerName: t('about.repository'),
      flex: 2,
      minWidth: 200,
      renderCell: (params) => {
        const url = params.value as string;
        if (!url) return null;
        return (
          <Link
            component="button"
            variant="body2"
            onClick={() => OpenURL(url)}
            sx={{
              textAlign: 'left',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '100%',
            }}
          >
            {url}
          </Link>
        );
      },
    },
  ];

  const rows = activeTab === 0 ? frontendLicenses : backendLicenses;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      disableRestoreFocus
    >
      <DialogTitle>{t('about.title')}</DialogTitle>
      <DialogContent>
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0.5,
            py: 2,
          }}
        >
          <Typography variant="h5" fontWeight="bold">
            Monaco Notepad
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t('about.version', { version })}
          </Typography>
          <Typography variant="body2">{t('about.developer')}</Typography>
          <Link
            component="button"
            variant="body2"
            onClick={() => OpenURL('https://jun-murakami.web.app/')}
          >
            {t('about.website')}
          </Link>
          <Typography variant="caption" color="text.secondary">
            {t('about.appLicense')}
          </Typography>
        </Box>

        <Divider sx={{ mb: 2 }} />

        <Tabs
          value={activeTab}
          onChange={(_, v) => setActiveTab(v)}
          sx={{ mb: 1 }}
        >
          <Tab label={t('about.frontendDependencies')} />
          <Tab label={t('about.backendDependencies')} />
        </Tabs>

        <Box sx={{ height: 400 }}>
          <DataGrid
            rows={rows}
            columns={columns}
            density="compact"
            disableRowSelectionOnClick
            pageSizeOptions={[25, 50, 100]}
            initialState={{
              pagination: { paginationModel: { pageSize: 25 } },
            }}
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('about.close')}</Button>
      </DialogActions>
    </Dialog>
  );
};
