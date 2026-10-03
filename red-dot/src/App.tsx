import { BrowserRouter, Route, Routes } from 'react-router';
import RedDotPage from './components/RedDotCode/RedDotPage.tsx'
import './index.css';

function App() {

	return (
		<BrowserRouter>
			<Routes>
      				<Route path="/*" element={<RedDotPage />} />
			</Routes>
		</BrowserRouter>
	);
}

export default App
