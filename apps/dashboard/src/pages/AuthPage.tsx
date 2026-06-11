import { useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { PhoneScreen } from './auth/PhoneScreen'
import { OtpScreen } from './auth/OtpScreen'
import { setSession } from '../lib/auth'

type Step = 'phone' | 'otp'
type Mode = 'signup' | 'signin'

export default function AuthPage() {
  const navigate = useNavigate()
  const { location } = useRouterState()
  const [step, setStep] = useState<Step>('phone')
  const [mode, setMode] = useState<Mode>(location.pathname === '/sign-up' ? 'signup' : 'signin')
  const [phone, setPhone] = useState('')

  const goBack = () => window.history.back()

  return (
    <div className="app app--auth">
      {step === 'phone' && (
        <PhoneScreen
          mode={mode}
          onBack={goBack}
          onSwitchMode={() => {
            setMode(m => m === 'signup' ? 'signin' : 'signup')
            navigate({ to: mode === 'signup' ? '/login' : '/sign-up' })
          }}
          onNext={ph => { setPhone(ph); setStep('otp') }}
        />
      )}
      {step === 'otp' && (
        <OtpScreen
          phone={phone}
          mode={mode}
          onBack={() => setStep('phone')}
          onSuccess={session => {
            setSession(session)
            void navigate({ to: mode === 'signup' ? '/onboarding/setup' : '/' })
          }}
        />
      )}
    </div>
  )
}
