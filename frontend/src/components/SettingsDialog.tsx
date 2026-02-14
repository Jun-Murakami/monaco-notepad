import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OpenAppFolder, OpenConflictBackupFolder } from '../../wailsjs/go/backend/App';
import * as runtime from '../../wailsjs/runtime';
import { THEME_PAIRS } from '../lib/monaco';
import type { Settings } from '../types';
import { DEFAULT_EDITOR_SETTINGS } from '../types';
import { LightDarkSwitch } from './LightDarkSwitch';

interface SettingsDialogProps {
  open: boolean;
  settings: Settings;
  onClose: () => void;
  onSave: (settings: Settings) => void;
  onChange: (settings: Settings) => void;
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({ open, settings, onClose, onSave, onChange }) => {
  const [localSettings, setLocalSettings] = useState<Settings>({ ...settings });
  const { t } = useTranslation();

  // ダイアログが開かれたときに現在の設定を保存
  useEffect(() => {
    if (open) {
      setLocalSettings({ ...settings });
    }
  }, [open, settings]);

  const handleChange = async (newSettings: Partial<Settings>) => {
    const updatedSettings = { ...localSettings, ...newSettings };
    setLocalSettings(updatedSettings);

    onChange(updatedSettings);
  };

  const handleClose = () => {
    // フォーカスを解放してから閉じる
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    // キャンセル時は元の設定に戻す
    onChange(settings);
    onClose();
  };

  const handleReset = () => {
    const resetSettings = {
      ...localSettings,
      ...DEFAULT_EDITOR_SETTINGS,
    };
    setLocalSettings(resetSettings);
    onChange(resetSettings);

    // ダークモード設定を反映
    if (resetSettings.isDarkMode) {
      runtime.WindowSetDarkTheme();
    } else {
      runtime.WindowSetLightTheme();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth='sm'
      fullWidth
      slotProps={{
        backdrop: {
          onExited: () => {
            if (document.activeElement instanceof HTMLElement) {
              document.activeElement.blur();
            }
          },
        },
      }}
    >
      <DialogTitle>{t('settings.title')}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 2 }}>
          {/* 言語設定 */}
          <FormControl fullWidth size='small'>
            <InputLabel>{t('settings.language')}</InputLabel>
            <Select
              value={localSettings.uiLanguage || 'system'}
              label={t('settings.language')}
              onChange={(e) => handleChange({ uiLanguage: e.target.value as 'system' | 'en' | 'ja' })}
            >
              <MenuItem value='system'>{t('settings.language_system')}</MenuItem>
              <MenuItem value='ja'>{t('settings.language_ja')}</MenuItem>
              <MenuItem value='en'>{t('settings.language_en')}</MenuItem>
            </Select>
          </FormControl>

          <Box sx={{ display: 'flex', flexDirection: 'row', gap: 2 }}>
            <TextField
              label={t('settings.fontFamily')}
              size='small'
              fullWidth
              value={localSettings.fontFamily}
              onChange={(e) => handleChange({ fontFamily: e.target.value })}
              helperText={t('settings.fontFamilyHelper')}
            />
            <FormControl sx={{ width: 150 }}>
              <InputLabel>{t('settings.fontSize')}</InputLabel>
              <Select
                size='small'
                value={localSettings.fontSize}
                label={t('settings.fontSize')}
                onChange={(e) => handleChange({ fontSize: e.target.value as number })}
              >
                {[8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].map((size) => (
                  <MenuItem key={size} value={size}>
                    {size}px
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          <FormControl fullWidth size='small'>
            <InputLabel>{t('settings.theme')}</InputLabel>
            <Select
              value={localSettings.editorTheme}
              label={t('settings.theme')}
              onChange={(e) => handleChange({ editorTheme: e.target.value as string })}
            >
              {THEME_PAIRS.map((pair) => (
                <MenuItem key={pair.id} value={pair.id}>
                  {pair.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Grid
            container
            spacing={2}
            sx={{
              display: 'flex',
              flexDirection: 'row',
              gap: 2,
              alignItems: 'center',
            }}
          >
            <Grid size={4}>
              <FormControlLabel
                control={
                  <LightDarkSwitch
                    checked={localSettings.isDarkMode}
                    onChange={(e) => {
                      handleChange({ isDarkMode: e.target.checked });
                      if (e.target.checked) {
                        runtime.WindowSetDarkTheme();
                      } else {
                        runtime.WindowSetLightTheme();
                      }
                    }}
                  />
                }
                label={localSettings.isDarkMode ? t('settings.darkMode') : t('settings.lightMode')}
              />
            </Grid>

            <Grid size={4}>
              <FormControlLabel
                control={
                  <Switch
                    checked={localSettings.wordWrap === 'on'}
                    size='small'
                    onChange={(e) =>
                      handleChange({
                        wordWrap: e.target.checked ? 'on' : 'off',
                      })
                    }
                  />
                }
                label={t('settings.wordWrap')}
              />
            </Grid>

            <Grid size={4}>
              <FormControlLabel
                control={
                  <Switch
                    size='small'
                    checked={localSettings.minimap}
                    onChange={(e) => handleChange({ minimap: e.target.checked })}
                  />
                }
                label={t('settings.minimap')}
              />
            </Grid>

            <Grid size={8}>
              <FormControlLabel
                control={
                  <Switch
                    size='small'
                    checked={localSettings.markdownPreviewOnLeft}
                    onChange={(e) => handleChange({ markdownPreviewOnLeft: e.target.checked })}
                  />
                }
                label={t('settings.markdownPreviewOnLeft')}
              />
            </Grid>

            <Divider orientation='horizontal' sx={{ width: '100%' }} />

            <Box
              sx={{
                display: 'flex',
                justifyContent: 'flex-start',
                gap: 2,
                alignItems: 'center',
                width: '100%',
              }}
            >
              <FormControlLabel
                control={
                  <Switch
                    size='small'
                    checked={localSettings.isDebug}
                    onChange={(e) => handleChange({ isDebug: e.target.checked })}
                  />
                }
                label={t('settings.debugMode')}
              />
              <Typography variant='caption' color='textSecondary'>
                {t('settings.debugModeDescriptionBeforeLink')}
                <Box
                  component='span'
                  onClick={() => OpenAppFolder()}
                  sx={{
                    textDecoration: 'underline',
                    cursor: 'pointer',
                    '&:hover': { color: 'primary.main' },
                  }}
                >
                  {t('settings.debugModeDescriptionLink')}
                </Box>
                {t('settings.debugModeDescriptionAfterLink')}
              </Typography>
            </Box>

            <Box
              sx={{
                display: 'flex',
                justifyContent: 'flex-start',
                gap: 2,
                alignItems: 'center',
                width: '100%',
              }}
            >
              <FormControlLabel
                control={
                  <Switch
                    size='small'
                    checked={localSettings.enableConflictBackup}
                    onChange={(e) =>
                      handleChange({
                        enableConflictBackup: e.target.checked,
                      })
                    }
                  />
                }
                label={t('settings.conflictBackup')}
              />
              <Typography variant='caption' color='textSecondary'>
                {t('settings.conflictBackupDescriptionBeforeLink')}
                <Box
                  component='span'
                  onClick={() => OpenConflictBackupFolder()}
                  sx={{
                    textDecoration: 'underline',
                    cursor: 'pointer',
                    '&:hover': { color: 'primary.main' },
                  }}
                >
                  {t('settings.conflictBackupDescriptionLink')}
                </Box>
                {t('settings.conflictBackupDescriptionAfterLink')}
              </Typography>
            </Box>
          </Grid>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleReset} color='primary'>
          {t('settings.resetToDefault')}
        </Button>
        <Box sx={{ flex: '1 0 0' }} />
        <Button onClick={handleClose}>{t('settings.cancel')}</Button>
        <Button onClick={() => onSave(localSettings)} variant='contained'>
          {t('settings.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
