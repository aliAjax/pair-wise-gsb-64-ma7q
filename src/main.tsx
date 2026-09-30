import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider } from 'react-redux'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import { store } from './store'
import { App } from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <FluentProvider theme={webLightTheme}>
        <App />
      </FluentProvider>
    </Provider>
  </React.StrictMode>
)
