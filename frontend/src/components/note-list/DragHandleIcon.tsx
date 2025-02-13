import { IconButton } from '@mui/material';
import { DragHandle, ImportExport } from '@mui/icons-material';

interface DragHandleIconProps {
  className: string;
  isDragging: boolean;
  attributes: any;
  listeners: any;
}

export const DragHandleIcon: React.FC<DragHandleIconProps> = ({ className, isDragging, attributes, listeners }) => {
  return (
    <IconButton
      className={className}
      {...attributes}
      {...listeners}
      sx={{
        opacity: 0,
        transition: 'opacity 0.2s',
        p: 0.5,
        ml: -1,
      }}
    >
      {isDragging ? (
        <DragHandle sx={{ width: 16, height: 16, color: 'primary.main' }} />
      ) : (
        <ImportExport sx={{ width: 16, height: 16, color: 'action.disabled' }} />
      )}
    </IconButton>
  );
};
