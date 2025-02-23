import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
}

export function Card({
  children,
  className = '',
  ...props
}: CardProps & React.ComponentProps<'div'>) {
  return (
    <div className={`rounded-lg border ${className}`} {...props}>
      {children}
    </div>
  );
}

interface CardHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export function CardHeader({
  children,
  className = '',
  ...props
}: CardHeaderProps & React.ComponentProps<'div'>) {
  return (
    <div className={`flex flex-col space-y-1.5 p-6 ${className}`} {...props}>
      {children}
    </div>
  );
}

interface CardTitleProps {
  children: React.ReactNode;
  className?: string;
}

export function CardTitle({
  children,
  className = '',
  ...props
}: CardTitleProps & React.ComponentProps<'h3'>) {
  return (
    <h3
      className={`text-2xl font-semibold leading-none tracking-tight ${className}`}
      {...props}
    >
      {children}
    </h3>
  );
}

interface CardContentProps {
  children: React.ReactNode;
  className?: string;
}

export function CardContent({
  children,
  className = '',
  ...props
}: CardContentProps & React.ComponentProps<'div'>) {
  return (
    <div className={`p-6 pt-0 ${className}`} {...props}>
      {children}
    </div>
  );
}
