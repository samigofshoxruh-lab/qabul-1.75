import { Component, type ErrorInfo, type ReactNode } from "react";

/** Если в какой-то части сайта случится сбой, вместо пустого экрана покажем понятное сообщение. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Сбой интерфейса:", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="crash">
        <h1>Что-то пошло не так</h1>
        <p>Страница перестала отвечать. Ваши данные в безопасности. Обновите страницу, и всё продолжит работать.</p>
        <div className="button-row">
          <button type="button" className="button button-primary" onClick={() => window.location.reload()}>Обновить страницу</button>
          <button type="button" className="button" onClick={() => { window.location.hash = "#/"; window.location.reload(); }}>На главную</button>
        </div>
      </main>
    );
  }
}
