import { useState, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { SplashScreen } from './auth/SplashScreen'
import { OnboardingScreen } from './auth/OnboardingScreen'
import { WelcomeScreen } from './auth/WelcomeScreen'
import { PhoneScreen } from './auth/PhoneScreen'
import { OtpScreen } from './auth/OtpScreen'
import { ProfileScreen } from './auth/ProfileScreen'
import { ConnectWAScreen } from './auth/ConnectWAScreen'
import { setSession } from '../lib/auth'

type Step = 'splash' | 'onboarding' | 'welcome' | 'phone' | 'otp' | 'profile' | 'connect'
type Mode = 'signup' | 'signin'

const SAW_SPLASH_KEY = 'mesa.seen_splash'

export default function AuthPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>(() =>
    localStorage.getItem(SAW_SPLASH_KEY) ? 'welcome' : 'splash'
  )
  const [mode, setMode] = useState<Mode>('signup')
  const [phone, setPhone] = useState('')
  const [pendingSession, setPendingSession] = useState<{ token: string; merchantId: string } | null>(null)

  useEffect(() => {
    if (step === 'onboarding') localStorage.setItem(SAW_SPLASH_KEY, '1')
  }, [step])

  const enterApp = () => navigate({ to: '/' })

  return (
    <div className="app app--auth">
      {step === 'splash' && (
        <SplashScreen onDone={() => setStep('onboarding')} />
      )}
      {step === 'onboarding' && (
        <OnboardingScreen onDone={() => setStep('welcome')} />
      )}
      {step === 'welcome' && (
        <WelcomeScreen
          onSignup={() => { setMode('signup'); setStep('phone') }}
          onSignin={() => { setMode('signin'); setStep('phone') }}
        />
      )}
      {step === 'phone' && (
        <PhoneScreen
          mode={mode}
          onBack={() => setStep('welcome')}
          onNext={ph => { setPhone(ph); setStep('otp') }}
        />
      )}
      {step === 'otp' && (
        <OtpScreen
          phone={phone}
          mode={mode}
          onBack={() => setStep('phone')}
          onSuccess={session => {
            if (mode === 'signin') {
              setSession(session)
              enterApp()
            } else {
              setPendingSession(session)
              setStep('profile')
            }
          }}
        />
      )}
      {step === 'profile' && pendingSession && (
        <ProfileScreen
          merchantId={pendingSession.merchantId}
          onBack={() => setStep('otp')}
          onNext={() => setStep('connect')}
        />
      )}
      {step === 'connect' && pendingSession && (
        <ConnectWAScreen
          session={pendingSession}
          onBack={() => setStep('profile')}
          onDone={() => { setSession(pendingSession!); enterApp() }}
        />
      )}
    </div>
  )
}
