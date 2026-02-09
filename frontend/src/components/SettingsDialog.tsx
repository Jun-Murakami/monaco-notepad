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
import { OpenAppFolder } from '../../wailsjs/go/backend/App';
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

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  open,
  settings,
  onClose,
  onSave,
  onChange,
}) => {
  const [localSettings, setLocalSettings] = useState<Settings>({ ...settings });

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
      maxWidth="sm"
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
              label="Font Family"
              size="small"
              fullWidth
              value={localSettings.fontFamily}
              onChange={(e) => handleChange({ fontFamily: e.target.value })}
              helperText="You can specify multiple fonts separated by commas."
            />
            <FormControl sx={{ width: 100 }}>
              <InputLabel>Font Size</InputLabel>
              <Select
                size="small"
                value={localSettings.fontSize}
                label="Font Size"
                onChange={(e) =>
                  handleChange({ fontSize: e.target.value as number })
                }
              >
                {[
                  8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
                  24,
                ].map((size) => (
                  <MenuItem key={size} value={size}>
                    {size}px
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          <FormControl fullWidth size="small">
            <InputLabel>Editor Theme</InputLabel>
            <Select
              value={localSettings.editorTheme}
              label="Editor Theme"
              onChange={(e) =>
                handleChange({ editorTheme: e.target.value as string })
              }
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
                label={localSettings.isDarkMode ? 'Dark Mode' : 'Light Mode'}
              />
            </Grid>

            <Grid size={4}>
              <FormControlLabel
                control={
                  <Switch
                    checked={localSettings.wordWrap === 'on'}
                    size="small"
                    onChange={(e) =>
                      handleChange({
                        wordWrap: e.target.checked ? 'on' : 'off',
                      })
                    }
                  />
                }
                label="Word Wrap"
              />
            </Grid>

            <Grid size={4}>
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={localSettings.minimap}
                    onChange={(e) =>
                      handleChange({ minimap: e.target.checked })
                    }
                  />
                }
                label="Minimap"
              />
            </Grid>

            <Divider orientation="horizontal" sx={{ width: '100%' }} />

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
                    size="small"
                    checked={localSettings.isDebug}
                    onChange={(e) =>
                      handleChange({ isDebug: e.target.checked })
                    }
                  />
                }
                label="Debug Mode"
              />
              <Typography variant="caption" color="textSecondary">
                Debug mode will output logs to{' '}
                <Box
                  component="span"
                  onClick={() => OpenAppFolder()}
                  sx={{
                    textDecoration: 'underline',
                    cursor: 'pointer',
                    '&:hover': { color: 'primary.main' },
                  }}
                >
                  app folder
                </Box>
                .
              </Typography>
            </Box>
          </Grid>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleReset} color="primary">
          Reset to Default
        </Button>
        <Box sx={{ flex: '1 0 0' }} />
        <Button onClick={handleClose}>Cancel</Button>
        <Button onClick={() => onSave(localSettings)} variant="contained">
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
};
