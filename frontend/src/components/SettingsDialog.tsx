import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Divider,
  Button,
  TextField,
  Typography,
  FormControl,
  InputLabel,
  Select,
  Switch,
  MenuItem,
  FormControlLabel,
  Box,
  Grid2 as Grid,
} from '@mui/material';
import { LightDarkSwitch } from './LightDarkSwitch';
import { EditorSettings, DEFAULT_EDITOR_SETTINGS } from '../types';
import * as runtime from '../../wailsjs/runtime';

interface SettingsDialogProps {
  open: boolean;
  settings: EditorSettings;
  onClose: () => void;
  onSave: (settings: EditorSettings) => void;
  onChange: (settings: EditorSettings) => void;
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({ open, settings, onClose, onSave, onChange }) => {
  const [localSettings, setLocalSettings] = useState<EditorSettings>({ ...settings });

  // ダイアログが開かれたときに現在の設定を保存
  useEffect(() => {
    if (open) {
      setLocalSettings({ ...settings });
    }
  }, [open, settings]);

  const handleChange = async (newSettings: Partial<EditorSettings>) => {
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
      <DialogTitle>Editor Settings</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 2 }}>
          <Box sx={{ display: 'flex', flexDirection: 'row', gap: 2 }}>
            <TextField
              label='Font Family'
              size='small'
              fullWidth
              value={localSettings.fontFamily}
              onChange={(e) => handleChange({ fontFamily: e.target.value })}
              helperText='You can specify multiple fonts separated by commas.'
            />
            <FormControl sx={{ width: 100 }}>
              <InputLabel>Font Size</InputLabel>
              <Select
                size='small'
                value={localSettings.fontSize}
                label='Font Size'
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

          <Grid container spacing={2} sx={{ display: 'flex', flexDirection: 'row', gap: 2, alignItems: 'center' }}>
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
                label={localSettings.isDarkMode ? 'Dark Mode' : 'Light Mode'}
              />
            </Grid>

            <Grid size={4}>
              <FormControlLabel
                control={
                  <Switch
                    checked={localSettings.wordWrap === 'on'}
                    size='small'
                    onChange={(e) => handleChange({ wordWrap: e.target.checked ? 'on' : 'off' })}
                  />
                }
                label='Word Wrap'
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
                label='Minimap'
              />
            </Grid>

            <Divider orientation='horizontal' sx={{ width: '100%' }} />

            <Box sx={{ display: 'flex', justifyContent: 'flex-start', gap: 2, alignItems: 'center', width: '100%' }}>
              <FormControlLabel
                control={
                  <Switch
                    size='small'
                    checked={localSettings.isDebug}
                    onChange={(e) => handleChange({ isDebug: e.target.checked })}
                  />
                }
                label='Debug Mode'
              />
              <Typography variant='caption' color='textSecondary'>
                Debug mode will output logs to app folder.
              </Typography>
            </Box>
          </Grid>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleReset} color='primary'>
          Reset to Default
        </Button>
        <Box sx={{ flex: '1 0 0' }} />
        <Button onClick={handleClose}>Cancel</Button>
        <Button onClick={() => onSave(localSettings)} variant='contained'>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
};
