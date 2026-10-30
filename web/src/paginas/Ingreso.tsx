import { useState, type FormEvent } from 'react';
import { api, ErrorApi } from '../api';

type Paso = 'CREDENCIALES' | 'VERIFICAR_MFA' | 'ENROLAR_MFA';

/** Ingreso con contraseña y doble factor (TOTP). Ninguna clave se guarda en el navegador. */
export function Ingreso({ alIngresar }: { alIngresar: () => Promise<void> }) {
  const [paso, setPaso] = useState<Paso>('CREDENCIALES');
  const [email, setEmail] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [codigo, setCodigo] = useState('');
  const [enrolamiento, setEnrolamiento] = useState<{ secreto: string; urlOtpAuth: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const intentar = async (fn: () => Promise<void>) => {
    setError(null);
    setEnviando(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : 'No se pudo conectar con el servidor.');
    } finally {
      setEnviando(false);
    }
  };

  const enviarCredenciales = (ev: FormEvent) => {
    ev.preventDefault();
    void intentar(async () => {
      const r = await api.post<{ siguientePaso: 'VERIFICAR_MFA' | 'ENROLAR_MFA' }>('/auth/login', { email, contrasena });
      setContrasena('');
      if (r.siguientePaso === 'ENROLAR_MFA') {
        setEnrolamiento(await api.post<{ secreto: string; urlOtpAuth: string }>('/auth/mfa/enrolar'));
      }
      setPaso(r.siguientePaso);
    });
  };

  const enviarCodigo = (ev: FormEvent) => {
    ev.preventDefault();
    void intentar(async () => {
      await api.post(paso === 'ENROLAR_MFA' ? '/auth/mfa/activar' : '/auth/mfa/verificar', { codigo });
      setCodigo('');
      await alIngresar();
    });
  };

  return (
    <div className="ingreso">
      <h1>ERP Agéntico</h1>
      {paso === 'CREDENCIALES' ? (
        <form onSubmit={enviarCredenciales}>
          <label>
            Correo
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Contraseña
            <input
              type="password"
              autoComplete="current-password"
              value={contrasena}
              onChange={(e) => setContrasena(e.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={enviando}>
            Ingresar
          </button>
        </form>
      ) : (
        <form onSubmit={enviarCodigo}>
          {paso === 'ENROLAR_MFA' && enrolamiento ? (
            <div className="aviso">
              <p>Configure el doble factor en su aplicación de autenticación (Google Authenticator, Microsoft Authenticator u otra).</p>
              <p>
                Clave para ingresar a mano: <code>{enrolamiento.secreto}</code>
              </p>
              <p className="pequeno">
                O abra este enlace en el teléfono: <a href={enrolamiento.urlOtpAuth}>agregar cuenta</a>
              </p>
            </div>
          ) : (
            <p>Ingrese el código de 6 dígitos de su aplicación de autenticación.</p>
          )}
          <label>
            Código
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={codigo}
              onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))}
              required
            />
          </label>
          <button type="submit" disabled={enviando}>
            {paso === 'ENROLAR_MFA' ? 'Activar y entrar' : 'Verificar'}
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
