import { create } from 'zustand';
import { authService } from '@/services/auth/authService';

interface AuthStoreState {
	signedIn: boolean;
	initializing: boolean;
}

export const useAuthStore = create<AuthStoreState>(() => ({
	signedIn: false,
	initializing: true,
}));

authService.onAuthChange(({ signedIn }) => {
	useAuthStore.setState({ signedIn });
});
